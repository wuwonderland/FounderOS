/**
 * Backend execution loop for the three "live" agents — dev, ops, research
 * (lib/agents/tools/index.ts's LIVE_AGENT_IDS). Uses the Vercel AI SDK's
 * own multi-step tool support (generateText + stopWhen: stepCountIs) rather
 * than a hand-rolled call/parse/re-call loop — the SDK already handles
 * tool-call parsing, retries, and step bookkeeping correctly.
 *
 * Action-level gate: this is the Draft/Recommend/Act boundary
 * (lib/agents/orchestrator.ts's ACTION_BOUNDARY_PROMPT, .github/agent/identity.md
 * Golden Rule 1) applied at the tool layer instead of the task layer. Every
 * tool declares `sideEffect: 'read' | 'write'` (lib/agents/tools/types.ts).
 * A `read` tool's execute() runs immediately. A `write` tool's execute()
 * still runs (write-sideEffect tools are contractually non-mutating — they
 * only build and return a proposal, see tools/types.ts's docstring), but
 * this gate enforces the one invariant that actually matters for safety:
 * a write tool's result must never resolve `ok:true` — if it somehow did
 * (a bug in that tool's contract compliance), the gate overrides it to the
 * safe `{ ok:false, error:'approval_required' }` refusal before the model
 * ever sees it. A write tool's own honest failure (bad args, a diff that
 * didn't apply) is not a safety issue and passes through with its real
 * error message intact — only a false `ok:true` gets overridden. Every
 * call, read or write, is logged to the `tool_calls` table for
 * observability — see lib/db.ts's toolCalls repo and lib/schemas.ts's
 * ToolCallLogSchema.
 */
import { randomUUID } from 'node:crypto';
import { generateText, stepCountIs, tool } from 'ai';
import type { FounderDb } from '@/lib/db';
import type { AgentExecRun, ToolCallLog } from '@/lib/schemas';
import { resolveExecutorModel } from '@/lib/connectors/llm';
import { isLiveAgentId, toolsForAgent, type LiveAgentId } from '@/lib/agents/tools';
import type { AgentTool, ToolExecuteResult } from '@/lib/agents/tools/types';

export type ExecutorMessage = { role: 'user' | 'assistant'; content: string };

export type RunAgentOptions = {
  maxSteps?: number;
  timeoutMs?: number;
};

export type RunAgentResult = {
  runId: string;
  agentId: string;
  ok: boolean;
  status: 'completed' | 'failed' | 'timeout';
  text: string;
  stepCount: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
  toolCalls: ToolCallLog[];
};

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_TIMEOUT_MS = 120_000;

function resolveMaxSteps(override?: number): number {
  if (typeof override === 'number' && override > 0) return Math.floor(override);
  const fromEnv = Number(process.env.AGENT_MAX_STEPS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : DEFAULT_MAX_STEPS;
}

function resolveTimeoutMs(override?: number): number {
  if (typeof override === 'number' && override > 0) return Math.floor(override);
  const fromEnv = Number(process.env.AGENT_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : DEFAULT_TIMEOUT_MS;
}

const SYSTEM_PROMPTS: Record<LiveAgentId, string> = {
  dev: [
    'You are the dev agent for FounderOS. You read the live codebase (read_file, list_files, search_code) and',
    'propose changes (propose_patch) as unified diffs. You cannot write to disk yourself — propose_patch always',
    'returns approval_required and hands the proposal to a human reviewer via the Dev Team Agent Slack approval',
    'flow. Read the target file before proposing a diff so it applies cleanly. Never claim a change has been made;',
    'only that you have proposed one.',
  ].join(' '),
  ops: [
    'You are the ops agent for FounderOS. You triage the inbox and calendar: gmail_search, gmail_read,',
    'calendar_list. You cannot send email or create calendar events yourself — draft_reply and create_event always',
    'return approval_required with the proposed content for a human to review. Never claim a reply was sent or an',
    'event was created; only that you have proposed one.',
  ].join(' '),
  research: [
    'You are the research agent for FounderOS. You search the web (web_search) and read pages (web_fetch) to',
    'answer questions and gather sources. You cannot save notes yourself — save_note always returns',
    'approval_required with the proposed note for a human to review. Cite the URLs you drew on.',
  ].join(' '),
};

/** Builds the AI SDK `tool()` map for one agent's tool set, wrapping every
    tool's execute() with the write gate, a try/catch that converts any
    throw into the same structured-error shape tools are asked to return
    directly, and per-call logging via `onCall`. */
function buildGatedTools(
  agentTools: AgentTool[],
  onCall: (entry: { toolName: string; args: unknown; result: ToolExecuteResult; durationMs: number }) => void,
) {
  const entries = agentTools.map((agentTool) => {
    const wrapped = tool({
      description: agentTool.description,
      inputSchema: agentTool.parameters,
      execute: async (args: Record<string, unknown>): Promise<ToolExecuteResult> => {
        const start = Date.now();
        let result: ToolExecuteResult;
        try {
          const raw = await agentTool.execute(args);
          if (agentTool.sideEffect === 'write' && raw.ok) {
            // Defense in depth — see the module docstring. The ONLY thing
            // that actually matters for safety here is `ok`: a write tool
            // must never resolve `ok:true` (that's what "a mutation
            // happened" would look like to the model), full stop — a
            // genuine failure from the tool itself (bad args, a diff that
            // didn't apply) is not a safety issue and passes through
            // unmodified below so its real, useful error message survives.
            result = { ok: false, error: 'approval_required', retryable: false, meta: { data: raw.data } };
          } else {
            result = raw;
          }
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
        }
        onCall({ toolName: agentTool.name, args, result, durationMs: Date.now() - start });
        return result;
      },
    });
    return [agentTool.name, wrapped] as const;
  });
  return Object.fromEntries(entries);
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    if (/timed? ?out|aborted/i.test(err.message)) return true;
  }
  return false;
}

/** Runs one agent turn to completion (or failure, or timeout) — the
    multi-step tool-calling loop is entirely the AI SDK's (stopWhen:
    stepCountIs(maxSteps)); this function's own job is resolving a model,
    wiring the write gate, and turning the result (partial or complete)
    into a persisted, observable run. Never throws — a resolution failure
    (no LLM configured, model rejected, timeout) comes back as
    `{ ok:false, status:'failed'|'timeout', error }`, same "honest, not
    fake" convention as every other agent path in this repo. */
export async function runAgent(
  db: FounderDb,
  agentId: string,
  messages: ExecutorMessage[],
  opts: RunAgentOptions = {},
): Promise<RunAgentResult> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  if (!isLiveAgentId(agentId)) {
    const error = `unknown live agent: ${agentId} (must be one of dev, ops, research)`;
    const endedAt = new Date().toISOString();
    const run: AgentExecRun = { id: runId, agentId, startedAt, endedAt, status: 'failed', stepCount: 0, inputTokens: 0, outputTokens: 0, error };
    db.agentExecRuns.insert(run);
    return { runId, agentId, ok: false, status: 'failed', text: '', stepCount: 0, inputTokens: 0, outputTokens: 0, error, toolCalls: [] };
  }

  const maxSteps = resolveMaxSteps(opts.maxSteps);
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const agentTools = toolsForAgent(agentId) ?? [];

  const loggedCalls: ToolCallLog[] = [];
  let stepIndex = 0;
  const tools = buildGatedTools(agentTools, (entry) => {
    const call: ToolCallLog = {
      id: randomUUID(),
      runId,
      step: stepIndex,
      toolName: entry.toolName,
      args: entry.args,
      result: entry.result,
      ok: entry.result.ok,
      durationMs: entry.durationMs,
    };
    loggedCalls.push(call);
    db.toolCalls.insert(call);
  });

  // Partial-result accumulation — if the run times out or fails mid-flight,
  // these hold whatever completed steps actually produced, so a timeout
  // still returns a partial result instead of nothing.
  let stepCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let lastText = '';

  try {
    const { model } = await resolveExecutorModel();
    const result = await generateText({
      model,
      system: SYSTEM_PROMPTS[agentId],
      messages,
      tools,
      stopWhen: stepCountIs(maxSteps),
      timeout: timeoutMs,
      onStepFinish: (step) => {
        stepIndex += 1;
        stepCount += 1;
        inputTokens += step.usage.inputTokens ?? 0;
        outputTokens += step.usage.outputTokens ?? 0;
        if (step.text) lastText = step.text;
      },
    });

    const endedAt = new Date().toISOString();
    const finalInputTokens = result.usage.inputTokens ?? inputTokens;
    const finalOutputTokens = result.usage.outputTokens ?? outputTokens;
    const finalStepCount = result.steps.length || stepCount;
    db.agentExecRuns.insert({
      id: runId,
      agentId,
      startedAt,
      endedAt,
      status: 'completed',
      stepCount: finalStepCount,
      inputTokens: finalInputTokens,
      outputTokens: finalOutputTokens,
      error: null,
    });
    return {
      runId,
      agentId,
      ok: true,
      status: 'completed',
      text: result.text,
      stepCount: finalStepCount,
      inputTokens: finalInputTokens,
      outputTokens: finalOutputTokens,
      toolCalls: loggedCalls,
    };
  } catch (err) {
    const endedAt = new Date().toISOString();
    const status = isTimeoutError(err) ? 'timeout' : 'failed';
    const message = err instanceof Error ? err.message : String(err);
    db.agentExecRuns.insert({ id: runId, agentId, startedAt, endedAt, status, stepCount, inputTokens, outputTokens, error: message });
    return {
      runId,
      agentId,
      ok: false,
      status,
      text: lastText,
      stepCount,
      inputTokens,
      outputTokens,
      error: message,
      toolCalls: loggedCalls,
    };
  }
}

/**
 * Tech Lead orchestrator for the Dev Team Agent suite. Ingests a
 * high-level request (from Slack or the UI), asks an LLM to break it into
 * structured sub-tasks, and can run each task's READ-ONLY steps (file
 * inspection, git diff, typecheck) automatically. A `developer` task can
 * go one step further and draft a proposed file rewrite — but drafting is
 * as far as this module goes on its own.
 *
 * Deliberate safety boundary: nothing in this file calls
 * sandbox.writeFile without a human first calling applyApprovedChange.
 * Automated breakdown + inspection + drafting is judged safe to run
 * unattended (nothing here mutates the repo); actually writing to disk is
 * not, so it stays a separate, explicit step. See CLAUDE.md's existing
 * "agents are read-only" convention for the rest of this app — this suite
 * is a deliberate, scoped exception to that, and this boundary is why.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import { CRED_FILES, resolveCred } from '@/lib/creds';
import * as sandbox from '@/lib/agents/sandbox';
import { readAllMemoryFiles, updateMemory, type MemoryFileName } from '@/lib/connectors/github';
import { fetchCriteria, formatCriteriaForPrompt } from '@/lib/connectors/notion';
import type { AgentRole, ExecutionContext, ExecutionSource, Task, TaskResult } from '@/types/agent';

const MODEL_ID = process.env.DEV_TEAM_MODEL ?? 'gpt-5.6-sol';

function resolveOpenAIKey(): string | undefined {
  return resolveCred('OPENAI_API_KEY', [CRED_FILES.agentsEnv]);
}

// Golden Rule 1 — hardcoded here rather than left to arrive solely via the
// .github/agent/identity.md fetch below: that fetch is best-effort and
// currently unconfigured in this deployment (see lib/connectors/github.ts),
// and a safety boundary this load-bearing must never silently disappear
// from the prompt just because GitHub isn't wired up. The actual
// enforcement is still code-level (proposeChange never calls
// sandbox.writeFile; only applyApprovedChange does, and only via
// approveAndApply's SLACK_APPROVAL_USER_IDS check) — this text keeps the
// model's own self-description honest about that, it doesn't create the
// boundary by itself.
const ACTION_BOUNDARY_PROMPT =
  'GOLDEN RULE — Three-Level Action Boundary. Every task sits at exactly one level, and you never escalate ' +
  'yourself past it: (1) Draft — generate proposals/diffs/plans only, touching nothing outside your own output. ' +
  '(2) Recommend — present choices, trade-offs, and next steps for the operator to decide on. (3) Act — file ' +
  'writes, git pushes, or external API mutations, reachable ONLY after explicit human approval through the Slack ' +
  'approval gate, never as a direct consequence of your own planning or drafting. Default every task to Draft or ' +
  'Recommend. Never describe a task as "done", "applied", "pushed", or "deployed" — a drafted proposal is not a ' +
  'completed action, no matter how confident you are in it.';

const TECH_LEAD_SYSTEM_PROMPT =
  `${ACTION_BOUNDARY_PROMPT}\n\n` +
  'You are the Tech Lead agent for FounderOS\'s internal Dev Team Agent suite. Break the operator\'s request into ' +
  'a small number (1-5) of concrete, independently-reviewable sub-tasks. Each task gets exactly one role: ' +
  '"tech_lead" for a scoping/investigation task with no code change, "developer" for a task that will draft a ' +
  'code change, or "qa_engineer" for a task that only inspects/validates (e.g. "run typecheck and report"). ' +
  'List the repo-relative file paths (targetFiles) each task plausibly touches — when unsure whether a file ' +
  'exists, scope the task to "inspect and report" rather than assuming its contents. Never invent a task that ' +
  'claims to have already made a change; you are planning work, not reporting completed work.';

// ── Operator context injection (GitHub memory files + Notion criteria) ──
//
// .github/agent/{soul,identity,user,memory}.md, read via
// lib/connectors/github.ts, and (for drafting only) task criteria from a
// configured Notion database via lib/connectors/notion.ts. Both are
// best-effort: an unconfigured or unreachable GitHub/Notion connector
// degrades to an empty context block, never a failed plan — the Dev Team
// Agent must keep working with its base prompts alone when this repo's
// memory files or Notion aren't set up, same "never fake, degrade openly"
// convention as every connector in this app.
const MEMORY_LABELS: Record<MemoryFileName, string> = {
  soul: 'Soul (core principles)',
  identity: 'Identity',
  user: 'User standards',
  memory: 'Memory (prior decisions this agent has logged)',
};
const MEMORY_ORDER: MemoryFileName[] = ['soul', 'identity', 'user', 'memory'];

// Memory files change rarely; re-fetching all four from GitHub on every
// single planning/drafting call would add real network latency and burn
// API rate limit for no benefit. Short in-memory cache, process-lifetime
// scoped (same pattern as sandbox's working-memory log) — not correctness-
// critical, just avoids redundant calls within a short burst of activity.
const MEMORY_CACHE_TTL_MS = 5 * 60 * 1000;
let memoryFilesCache: { at: number; files: Partial<Record<MemoryFileName, string>> } | null = null;

async function getMemoryFilesCached(): Promise<Partial<Record<MemoryFileName, string>>> {
  const nowMs = Date.now();
  if (memoryFilesCache && nowMs - memoryFilesCache.at < MEMORY_CACHE_TTL_MS) return memoryFilesCache.files;
  const files = await readAllMemoryFiles();
  memoryFilesCache = { at: nowMs, files };
  return files;
}

function formatMemoryContext(files: Partial<Record<MemoryFileName, string>>): string {
  const sections = MEMORY_ORDER.filter((name) => files[name]).map((name) => `## ${MEMORY_LABELS[name]}\n${files[name]}`);
  if (sections.length === 0) return '';
  return `# Operator context (.github/agent/)\n\n${sections.join('\n\n')}`;
}

/** Context for the Tech Lead planning pass: the four memory files only —
    Notion criteria are injected later, at drafting time, scoped to the
    specific task being drafted rather than every plan. */
async function buildPlanningContext(): Promise<string> {
  return formatMemoryContext(await getMemoryFilesCached());
}

/** Context for a developer task actually drafting a change: memory files
    again, plus this task's relevant Notion acceptance criteria if
    NOTION_DATABASE_ID is configured. */
async function buildDraftingContext(task: Task): Promise<string> {
  const memoryBlock = formatMemoryContext(await getMemoryFilesCached());

  let criteriaBlock = '';
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (databaseId) {
    const result = await fetchCriteria(databaseId);
    if (result.ok) {
      const rendered = formatCriteriaForPrompt(result.items);
      if (rendered) criteriaBlock = `# Acceptance criteria (Notion database ${databaseId})\n\n${rendered}`;
    } else {
      console.warn(`[orchestrator] Notion criteria fetch failed for task "${task.title}":`, result.error);
    }
  }

  return [memoryBlock, criteriaBlock].filter(Boolean).join('\n\n');
}

const TaskDraftSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  role: z.enum(['tech_lead', 'developer', 'qa_engineer']),
  targetFiles: z.array(z.string()).default([]),
});
const BreakdownSchema = z.object({ tasks: z.array(TaskDraftSchema).min(1).max(5) });

function now(): string {
  return new Date().toISOString();
}

function draftToTask(draft: z.infer<typeof TaskDraftSchema>): Task {
  const ts = now();
  return {
    id: randomUUID(),
    title: draft.title,
    description: draft.description,
    role: draft.role as AgentRole,
    status: 'pending',
    targetFiles: draft.targetFiles,
    createdAt: ts,
    updatedAt: ts,
  };
}

/** Ingests a high-level request and produces a structured plan. Never
    throws and never fabricates a plan — a missing/failed LLM call comes
    back as an ExecutionContext with zero tasks and `planError` set, same
    "honest, not fake" convention every connector in this repo follows. */
export async function planFromRequest(
  originalRequest: string,
  source: ExecutionSource,
  slack?: ExecutionContext['slack'],
): Promise<ExecutionContext> {
  const requestId = randomUUID();
  const base = { requestId, source, slack, originalRequest, createdAt: now() };

  const key = resolveOpenAIKey();
  if (!key) {
    return { ...base, tasks: [], planError: 'OPENAI_API_KEY is not set — add it to .env.local to enable the Dev Team Agent.' };
  }

  try {
    const operatorContext = await buildPlanningContext();
    const system = operatorContext ? `${TECH_LEAD_SYSTEM_PROMPT}\n\n${operatorContext}` : TECH_LEAD_SYSTEM_PROMPT;
    const openai = createOpenAI({ apiKey: key });
    const { object } = await generateObject({
      model: openai.chat(MODEL_ID),
      system,
      schema: BreakdownSchema,
      prompt: originalRequest,
    });
    return { ...base, tasks: object.tasks.map(draftToTask) };
  } catch (err) {
    return { ...base, tasks: [], planError: err instanceof Error ? err.message : String(err) };
  }
}

/** Runs a task's READ-ONLY steps: git diff + typecheck for a qa_engineer
    task, or just marks a tech_lead scoping task complete (nothing to
    execute — it's the plan itself). Safe to run unattended; touches
    nothing on disk. */
export async function runReadOnlyTask(task: Task): Promise<Task> {
  if (task.role === 'tech_lead') {
    return { ...task, status: 'completed', result: { ok: true, summary: 'Scoping task — no execution needed.' }, updatedAt: now() };
  }
  if (task.role !== 'qa_engineer') return task; // developer tasks go through proposeChange instead

  const executing: Task = { ...task, status: 'executing', updatedAt: now() };
  const diff = await sandbox.getGitDiff();
  const typecheck = await sandbox.runTypecheck();

  const diffOutput = diff.ok ? diff.data : `git diff failed: ${diff.error}`;
  const typecheckOutput = typecheck.ok
    ? `${typecheck.data.passed ? 'typecheck PASSED' : 'typecheck FAILED'}\n${typecheck.data.output}`
    : `typecheck could not run: ${typecheck.error}`;
  const output = `${diffOutput}\n\n${typecheckOutput}`.trim();

  const passed = typecheck.ok && typecheck.data.passed;
  const result: TaskResult = passed
    ? { ok: true, summary: 'Typecheck passed.' }
    : { ok: false, summary: 'Typecheck failed — see output.', error: typecheck.ok ? typecheck.data.output : typecheck.error };

  return { ...executing, status: passed ? 'completed' : 'failed', output, result, updatedAt: now() };
}

/** Drafts a proposed rewrite for a developer task's first target file —
    reads the current content for context, asks the LLM for a full
    replacement, and stores it on the task WITHOUT writing it to disk. This
    is the human-approval boundary: the task lands in "validating" and
    stays there until a human calls applyApprovedChange below. */
export async function proposeChange(task: Task): Promise<Task> {
  if (task.role !== 'developer') return task;
  const targetFile = task.targetFiles[0];
  if (!targetFile) {
    return { ...task, status: 'failed', result: { ok: false, summary: 'No targetFiles given', error: 'developer task needs at least one target file' }, updatedAt: now() };
  }

  const executing: Task = { ...task, status: 'executing', updatedAt: now() };
  const key = resolveOpenAIKey();
  if (!key) {
    return { ...executing, status: 'failed', result: { ok: false, summary: 'OPENAI_API_KEY is not set', error: 'no LLM configured' }, updatedAt: now() };
  }

  const existing = await sandbox.readFile(targetFile);
  const currentContent = existing.ok ? existing.data : ''; // new file if it doesn't exist yet — honest either way, never guessed

  try {
    const operatorContext = await buildDraftingContext(task);
    const developerSystemPrompt =
      `${ACTION_BOUNDARY_PROMPT}\n\n` +
      'You are a Developer agent — you operate at the Draft level ONLY. You will be given a task and the CURRENT ' +
      'full content of one file (empty if the file does not exist yet). Respond with ONLY the complete new file ' +
      'content — no explanation, no markdown code fences, nothing but the file. Make the smallest change that ' +
      'satisfies the task. What you produce here is a proposal for review; it is not written to disk by you, and ' +
      "it never will be without a human approving it through the Slack gate. Follow the operator's standards and " +
      'acceptance criteria below when they apply to this file.';
    const system = operatorContext ? `${developerSystemPrompt}\n\n${operatorContext}` : developerSystemPrompt;
    const openai = createOpenAI({ apiKey: key });
    const { text } = await generateText({
      model: openai.chat(MODEL_ID),
      system,
      prompt: `Task: ${task.title}\n${task.description}\n\nFile: ${targetFile}\n\nCurrent content:\n${currentContent}`,
    });
    return {
      ...executing,
      status: 'validating',
      proposedContent: text,
      previousContent: currentContent,
      result: { ok: true, summary: `Proposed a change to ${targetFile} — awaiting approval, nothing written yet.` },
      updatedAt: now(),
    };
  } catch (err) {
    return { ...executing, status: 'failed', result: { ok: false, summary: 'Draft generation failed', error: err instanceof Error ? err.message : String(err) }, updatedAt: now() };
  }
}

/** Entry point for lib/agents/tools/dev.ts's `propose_patch` tool — the
    `dev` live agent hands a path + unified diff straight to this instead of
    going through planFromRequest's LLM breakdown (the diff is already fully
    specified by the calling model; there's nothing left to plan). Computes
    what the file would look like via sandbox.applyUnifiedDiff (never
    touches the real file), stores the result as a `validating` Task in the
    same task store planFromRequest/runPlan use, and returns just enough for
    the tool to report an honest `approval_required` refusal back to its
    caller. The task then goes through the EXACT same human-approval path
    as every other Dev Team Agent proposal — approveAndApply via
    approveAndApply(taskId, approverId) — nothing new to trust here. */
export async function proposePatchFromDiff(
  targetFile: string,
  diff: string,
): Promise<{ ok: true; taskId: string; diffPreview: string } | { ok: false; error: string }> {
  const applied = await sandbox.applyUnifiedDiff(targetFile, diff);
  if (!applied.ok) return { ok: false, error: applied.error };

  const preview = await sandbox.diffContent(applied.data.previousContent, applied.data.newContent, path.basename(targetFile));
  const ts = now();
  const task: Task = {
    id: randomUUID(),
    title: `Patch: ${targetFile}`,
    description: 'Proposed via the dev agent\'s propose_patch tool.',
    role: 'developer',
    status: 'validating',
    targetFiles: [targetFile],
    proposedContent: applied.data.newContent,
    previousContent: applied.data.previousContent,
    result: { ok: true, summary: `Proposed a change to ${targetFile} — awaiting approval, nothing written yet.` },
    createdAt: ts,
    updatedAt: ts,
  };
  saveTask(task);
  return { ok: true, taskId: task.id, diffPreview: preview.ok ? preview.data : diff };
}

// In-memory task store — process-lifetime only, not persisted across
// restarts (same scope as sandbox's working-memory log). Phase 1 never
// needed this (a plan's tasks only ever lived inside one function call);
// Phase 2's "approve <task_id>" needs to look a task up by ID from a
// LATER request, so tasks are now saved here as soon as they're produced.
const taskStore = new Map<string, Task>();

export function getTask(taskId: string): Task | undefined {
  return taskStore.get(taskId);
}

function saveTask(task: Task): Task {
  taskStore.set(task.id, task);
  return task;
}

/** Runs every task in a plan's read-only/drafting step — qa_engineer tasks
    execute for real (typecheck), developer tasks get a proposed diff
    (not applied), tech_lead tasks just complete. Safe to call unattended.
    Every resulting task is saved to the task store so a later "approve
    <task_id>" (Slack button or text command) can find it. */
export async function runPlan(context: ExecutionContext): Promise<ExecutionContext> {
  const tasks: Task[] = [];
  for (const task of context.tasks) {
    const result = task.role === 'developer' ? await proposeChange(task) : await runReadOnlyTask(task);
    tasks.push(saveTask(result));
  }
  return { ...context, tasks };
}

/** THE write path. Applies a developer task's proposedContent to disk via
    sandbox.writeFile, then re-runs typecheck as an immediate
    self-correction signal (the result is reported, not auto-retried —
    Phase 1 stops at one attempt). Only ever call this after a human has
    actually reviewed task.proposedContent; nothing in this module calls it
    on its own. */
export async function applyApprovedChange(task: Task): Promise<Task> {
  if (task.status !== 'validating' || !task.proposedContent) {
    return { ...task, status: 'failed', result: { ok: false, summary: 'Nothing to apply', error: 'task has no approved proposal' }, updatedAt: now() };
  }
  const targetFile = task.targetFiles[0];
  const write = await sandbox.writeFile(targetFile, task.proposedContent);
  if (!write.ok) {
    return { ...task, status: 'failed', result: { ok: false, summary: 'Write failed', error: write.error }, updatedAt: now() };
  }
  const typecheck = await sandbox.runTypecheck();
  const passed = typecheck.ok && typecheck.data.passed;
  const output = typecheck.ok ? typecheck.data.output : typecheck.error;
  return {
    ...task,
    status: passed ? 'completed' : 'failed',
    output,
    result: passed
      ? { ok: true, summary: `Applied to ${targetFile}; typecheck passed.` }
      : { ok: false, summary: `Applied to ${targetFile}, but typecheck failed.`, error: output },
    updatedAt: now(),
  };
}

/** Slack user IDs allowed to approve a real write. Deny-by-default: unset
    or empty means NOBODY is authorized, not "anyone who can message the
    bot" — the safest possible default for an action that writes to the
    real codebase. Set SLACK_APPROVAL_USER_IDS (comma-separated Slack user
    IDs, e.g. "U0BRCDFK3NW") in .env.local to actually enable approvals. */
function resolveApprovedUserIds(env: Record<string, string | undefined> = process.env): Set<string> {
  const raw = env.SLACK_APPROVAL_USER_IDS ?? '';
  return new Set(
    raw
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export type ApproveResult = { ok: true; task: Task } | { ok: false; message: string };

/** The single choke point every approval path (Slack button click, Slack
    text command) goes through — so the authorization check exists in
    exactly one place. Looks the task up by ID, checks the approver
    against the allowlist, and only then calls applyApprovedChange. */
export async function approveAndApply(
  taskId: string,
  approverId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ApproveResult> {
  const approved = resolveApprovedUserIds(env);
  if (approved.size === 0) {
    return { ok: false, message: 'No one is authorized to approve changes yet — set SLACK_APPROVAL_USER_IDS in .env.local.' };
  }
  if (!approved.has(approverId)) {
    return { ok: false, message: `<@${approverId}> isn't authorized to approve changes.` };
  }

  const task = getTask(taskId);
  if (!task) return { ok: false, message: `No task found with id \`${taskId}\` (the server may have restarted since it was proposed).` };
  if (task.status !== 'validating') {
    return { ok: false, message: `Task \`${taskId}\` is "${task.status}", not awaiting approval — nothing to apply.` };
  }

  const applied = saveTask(await applyApprovedChange(task));

  // Auto-memory update: log what was actually decided/done so future
  // planning/drafting calls (which read memory.md via
  // buildPlanningContext/buildDraftingContext) have this turn's context.
  // Best-effort — a memory-write failure is logged, never turned into a
  // failure of the approval itself; the real file change already landed
  // (or didn't) via applyApprovedChange above regardless of this.
  if (applied.status === 'completed') {
    const entry =
      `Task: ${applied.title}\n` +
      `File: ${applied.targetFiles[0] ?? 'n/a'}\n` +
      `Approved by: ${approverId}\n` +
      `Outcome: ${applied.result?.summary ?? 'applied'}`;
    try {
      const memoryResult = await updateMemory(entry, env);
      if (!memoryResult.ok) console.warn('[orchestrator] memory.md update failed:', memoryResult.error);
      else memoryFilesCache = null; // invalidate the cache — memory.md just changed
    } catch (err) {
      console.warn('[orchestrator] memory.md update threw:', err);
    }
  }

  return { ok: true, task: applied };
}

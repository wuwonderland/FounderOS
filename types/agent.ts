/**
 * Types for the autonomous "Dev Team Agent" suite (lib/agents/orchestrator.ts,
 * lib/agents/sandbox.ts, app/api/slack/events/route.ts). Distinct from the
 * existing read-only operator-agent roster in lib/schemas.ts (`Agent`,
 * `AgentStatus`) — these describe a different, higher-privilege agent kind
 * that can propose and (with explicit approval) apply real file changes.
 */

export type AgentRole = 'tech_lead' | 'developer' | 'qa_engineer';

export type TaskStatus = 'pending' | 'executing' | 'validating' | 'completed' | 'failed';

export type Task = {
  id: string;
  title: string;
  description: string;
  role: AgentRole;
  status: TaskStatus;
  /** Repo-relative paths this task is expected to touch or inspect —
      assigned by the tech lead during breakdown; scopes what the sandbox
      will let the worker executing this task read or write. */
  targetFiles: string[];
  /** Full proposed new content for the (first) target file, once a
      developer worker has drafted one. Presence of this field is what
      moves a task to 'validating' — Phase 1 never applies it
      automatically; see applyApprovedChange in orchestrator.ts. */
  proposedContent?: string;
  /** The target file's content as read at drafting time, before any
      change — '' if the file didn't exist yet. Stored alongside
      proposedContent so a diff can be rendered (e.g. for a Slack approval
      message) without a second file read or an approve-time race. */
  previousContent?: string;
  /** Sandbox output relevant to this task (e.g. a typecheck run) — the
      material a self-correction loop or a human reviewer reads. */
  output?: string;
  result?: TaskResult;
  createdAt: string;
  updatedAt: string;
};

export type TaskResult = {
  ok: boolean;
  summary: string;
  error?: string;
};

export type ExecutionSource = 'slack' | 'ui' | 'cli';

export type ExecutionContext = {
  requestId: string;
  /** Where this request originated — determines how results get reported
      back (a Slack thread reply vs. a UI panel vs. stdout). */
  source: ExecutionSource;
  /** Slack routing info, present only when source === 'slack'. */
  slack?: { channel: string; threadTs?: string; userId: string };
  /** The original high-level ask, verbatim. */
  originalRequest: string;
  tasks: Task[];
  /** Set when the tech lead itself failed to produce a plan (e.g. no LLM
      configured) — the context still exists (for logging/reporting) but
      carries no tasks. */
  planError?: string;
  createdAt: string;
};

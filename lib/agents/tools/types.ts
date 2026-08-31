/**
 * Shared tool contract for the executor loop (lib/agents/executor.ts) and
 * the three live agents' tool sets (lib/agents/tools/{dev,ops,research}.ts).
 *
 * `sideEffect` is what lib/agents/executor.ts's action-level gate reads to
 * decide whether a tool call runs immediately (`read`) or is intercepted
 * before it can do anything (`write`) — see the gate's docstring for the
 * full contract. Every `write`-sideEffect tool's `execute()` MUST be safe
 * to call unconditionally: it may read live data and build a proposal, but
 * it must never itself call a mutating primitive (sandbox.writeFile, an
 * API call that sends/creates/deletes something real). The gate enforces
 * the outer `approval_required` shape as a backstop even if a tool's own
 * `execute()` gets that wrong — but the contract is still on the tool.
 */
import type { z } from 'zod';

export type ToolSuccess = { ok: true; data: unknown };
export type ToolFailure = {
  ok: false;
  error: string;
  retryable: boolean;
  /** Extra structured detail beyond the required shape — e.g. a write
      tool's `proposalId` once the gate (or the tool itself) has assigned
      one. Optional so the base failure shape stays exactly what the spec
      asks for. */
  meta?: Record<string, unknown>;
};
export type ToolExecuteResult = ToolSuccess | ToolFailure;

export type AgentTool = {
  name: string;
  /** One sentence, written for the model deciding whether to call this
      tool — not documentation for a human reader. */
  description: string;
  parameters: z.ZodTypeAny;
  sideEffect: 'read' | 'write';
  execute: (args: Record<string, unknown>) => Promise<ToolExecuteResult>;
};

export function ok(data: unknown): ToolSuccess {
  return { ok: true, data };
}

export function fail(error: string, retryable = false, meta?: Record<string, unknown>): ToolFailure {
  return { ok: false, error, retryable, ...(meta ? { meta } : {}) };
}

/** The fixed shape every write-sideEffect tool resolves to once its
    execute() has built a proposal — never retryable (it's not a transient
    failure, it's the gate working as designed) and always carrying the
    proposal's id so the model (and a human reviewer) can refer back to it. */
export function approvalRequired(proposalId: string, meta?: Record<string, unknown>): ToolFailure {
  return { ok: false, error: 'approval_required', retryable: false, meta: { proposalId, ...meta } };
}

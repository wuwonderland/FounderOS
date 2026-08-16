'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Badge, Dot } from '@/components/terminal';

export type ApprovalLastRun = { ok: boolean; summary: string; relativeTime: string } | null;
export type ApprovalCommsContext = { source: string; sender: string; preview: string; relativeTime: string } | null;

/** Review card for an agent that needs a human look. Pulls the agent's real
    last-run record and the most recent real inbound comms item (if any) —
    there's no drafted-email/send pipeline in this repo yet, so Approve/Reject
    only records a local decision rather than claiming to dispatch anything. */
export function AgentApprovalCard({
  agentName,
  role,
  lastRun,
  commsContext,
}: {
  agentName: string;
  role: string;
  lastRun: ApprovalLastRun;
  commsContext: ApprovalCommsContext;
}) {
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hoverable shrink-0 border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2.5 py-[3px] font-mono text-[11px] font-semibold text-os-accent"
      >
        Review
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md border border-os-border-strong bg-os-surface/95 p-6 backdrop-blur-xl"
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-os-dim">Review · {role}</div>
                  <h2 className="mt-1 text-[15px] font-bold uppercase tracking-[0.04em] text-os-text">{agentName}</h2>
                </div>
                <button onClick={() => setOpen(false)} className="text-os-dim hover:text-os-text">
                  ✕
                </button>
              </div>

              <div className="mb-4 border border-os-border bg-os-bg2 p-3.5 font-mono text-[11.5px]">
                <div className="mb-1.5 flex items-center gap-2 text-os-dim">
                  <Dot state={lastRun ? (lastRun.ok ? 'ok' : 'err') : 'off'} />
                  {lastRun ? (lastRun.ok ? 'Last run OK' : 'Last run FAILED') : 'Never run'}
                  {lastRun && <span className="text-os-border-strong">· {lastRun.relativeTime} ago</span>}
                </div>
                <p className="text-os-muted">{lastRun?.summary ?? 'No run history for this agent yet.'}</p>
              </div>

              {commsContext && (
                <div className="mb-6 border border-os-border bg-os-bg2 p-3.5 font-mono text-[11.5px]">
                  <div className="mb-1.5 text-[9.5px] uppercase tracking-[0.18em] text-os-dim">
                    Recent inbound · {commsContext.source} · {commsContext.relativeTime} ago
                  </div>
                  <div className="text-os-muted">{commsContext.sender}</div>
                  <p className="mt-1 text-os-dim">{commsContext.preview}</p>
                </div>
              )}

              {decision ? (
                <div
                  className={`border px-3.5 py-3 text-center font-mono text-[11px] uppercase tracking-[0.14em] ${
                    decision === 'approved' ? 'border-[var(--accent-line)] text-os-ok' : 'border-os-border-strong text-os-err'
                  }`}
                >
                  {decision === 'approved' ? 'Approved' : 'Rejected'} — local decision only, nothing was sent
                </div>
              ) : (
                <div className="flex gap-3">
                  <button
                    onClick={() => setDecision('approved')}
                    className="hoverable flex-1 border border-[var(--accent-line)] bg-[var(--accent-soft)] py-2.5 font-mono text-[11.5px] font-semibold uppercase tracking-[0.1em] text-os-accent"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => setDecision('rejected')}
                    className="hoverable flex-1 border border-os-border-strong py-2.5 font-mono text-[11.5px] font-semibold uppercase tracking-[0.1em] text-os-muted"
                  >
                    Reject
                  </button>
                </div>
              )}
              <Badge tone="default" ghost>
                no send pipeline — decision recorded in this view only
              </Badge>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

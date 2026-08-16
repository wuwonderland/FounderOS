'use client';

import { useState } from 'react';

export type BITile = { label: string; value: string; unit?: string; tone?: 'ok' | 'warn' | 'err' };

const TONE_CLASS: Record<NonNullable<BITile['tone']>, string> = {
  ok: 'text-os-ok',
  warn: 'text-os-warn',
  err: 'text-os-err',
};

/** Collapsible dock of real, already-computed pulse numbers — no invented
    revenue or market-size figures, just a second view onto the same live
    data the pulse row renders. */
export function BIDock({ tiles }: { tiles: BITile[] }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="hoverable fixed right-0 top-1/2 z-30 -translate-y-1/2 border border-os-border-strong bg-os-surface px-1.5 py-3 font-mono text-[10px] text-os-dim transition-colors hover:text-os-accent"
        aria-label={open ? 'Collapse data dock' : 'Expand data dock'}
      >
        {open ? '›' : '‹'}
      </button>
      <div
        className={`fixed right-0 top-0 z-30 h-full w-72 border-l border-os-border bg-os-surface/95 p-5 backdrop-blur-md transition-transform duration-300 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="mb-5 font-mono text-[9.5px] uppercase tracking-[0.24em] text-os-dim">// Live pulse</div>
        <div className="flex flex-col gap-3">
          {tiles.map((t) => (
            <div key={t.label} className="border border-os-border bg-os-bg2 px-3.5 py-3">
              <div className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-os-dim">{t.label}</div>
              <div className={`mt-1 font-mono text-[20px] font-semibold ${t.tone ? TONE_CLASS[t.tone] : 'text-os-text'}`}>
                {t.value}
                {t.unit && <span className="ml-1.5 text-[11px] font-normal text-os-dim">{t.unit}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

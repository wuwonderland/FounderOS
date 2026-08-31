import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { runAgent, type ExecutorMessage } from '@/lib/agents/executor';
import { isLiveAgentId } from '@/lib/agents/tools';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // better-sqlite3 is native — keep off the edge runtime

const MAX_HISTORY_TURNS = 16;

function parseHistory(value: unknown): ExecutorMessage[] {
  if (!Array.isArray(value)) return [];
  const turns: ExecutorMessage[] = [];
  for (const entry of value) {
    if (
      entry &&
      typeof entry === 'object' &&
      ((entry as { role?: unknown }).role === 'user' || (entry as { role?: unknown }).role === 'assistant') &&
      typeof (entry as { content?: unknown }).content === 'string'
    ) {
      turns.push({ role: (entry as ExecutorMessage).role, content: (entry as ExecutorMessage).content });
    }
  }
  return turns.slice(-MAX_HISTORY_TURNS);
}

/** Runs one of the three live agents (dev/ops/research) through the full
    tool-calling execution loop (lib/agents/executor.ts). Distinct from the
    existing POST /api/agents/[id]/run (lib/agents/runtime.ts's simple
    status-check run()) and POST /api/agents/[id]/chat (read-only chat,
    lib/agents/chat.ts) — this is the one route that can reach a write
    tool's approval-required proposal. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : '';
  const message = typeof body?.message === 'string' ? body.message.trim() : '';

  if (!agentId) return NextResponse.json({ error: 'agentId is required' }, { status: 400 });
  if (!isLiveAgentId(agentId)) {
    return NextResponse.json({ error: `unknown live agent: ${agentId} (must be one of dev, ops, research)` }, { status: 404 });
  }
  if (!message) return NextResponse.json({ error: 'message is required' }, { status: 400 });

  const messages: ExecutorMessage[] = [...parseHistory(body?.history), { role: 'user', content: message }];
  const maxSteps = typeof body?.maxSteps === 'number' ? body.maxSteps : undefined;
  const timeoutMs = typeof body?.timeoutMs === 'number' ? body.timeoutMs : undefined;

  const result = await runAgent(getDb(), agentId, messages, { maxSteps, timeoutMs });
  return NextResponse.json({ runId: result.runId, result });
}

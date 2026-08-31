import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '@/lib/db';
import { routeConductorMessage } from '@/lib/agents/conductor';
import { realAgents } from '@/lib/agents/real';
import { isLiveAgentId } from '@/lib/agents/tools';

const prevLlm = process.env.LLM_PROVIDER;
const prevBrain = process.env.BRAIN_PROVIDER;
beforeAll(() => {
  process.env.LLM_PROVIDER = 'stub';
  process.env.BRAIN_PROVIDER = 'stub';
});
afterAll(() => {
  if (prevLlm === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevLlm;
  if (prevBrain === undefined) delete process.env.BRAIN_PROVIDER;
  else process.env.BRAIN_PROVIDER = prevBrain;
});

// Candidate set is restricted to the "live" agents (dev/ops/research) — see
// lib/agents/conductor.ts's routeConductorMessage. Every other seeded agent
// is unreachable through the Conductor now, though still reachable directly
// via /api/agents/[id]/chat and /api/agents/[id]/run.
const routableIds = () => realAgents.filter((a) => a.id !== 'conductor' && isLiveAgentId(a.id)).map((a) => a.id);

describe('routeConductorMessage (stub)', () => {
  test('@agent-id prefix routes straight to that agent and strips the prefix', async () => {
    const db = openDb(':memory:');
    const res = await routeConductorMessage(db, realAgents, '@dev what changed recently?');
    expect(res.routedTo).toBe('dev');
    expect(res.reply.length).toBeGreaterThan(0);
    expect(db.agentMessages.byAgent('dev')[0].content).toBe('what changed recently?');
  });

  test('@Name matches by humanized name slug too', async () => {
    const db = openDb(':memory:');
    const res = await routeConductorMessage(db, realAgents, '@Dev-Agent ping');
    expect(res.routedTo).toBe('dev');
  });

  test('a bare message routes to a valid non-conductor agent and returns a reply', async () => {
    const db = openDb(':memory:');
    const res = await routeConductorMessage(db, realAgents, 'how is the pipeline looking?');
    expect(routableIds()).toContain(res.routedTo);
    expect(res.routedTo).not.toBe('conductor');
    expect(res.reply.length).toBeGreaterThan(0);
  });

  test('an unknown @name never throws — falls back to routing', async () => {
    const db = openDb(':memory:');
    const res = await routeConductorMessage(db, realAgents, '@nobody hello');
    expect(res.routedTo).not.toBe('conductor');
    expect(res.reply.length).toBeGreaterThan(0);
  });
});

describe('POST /api/agents/conductor/chat', () => {
  beforeAll(() => {
    process.env.FOUNDER_OS_DB = path.join(mkdtempSync(path.join(tmpdir(), 'founder-os-cond-')), 'test.db');
  });

  test('routes through the conductor and returns routedTo + reply', async () => {
    const { POST } = await import('@/app/api/agents/[id]/chat/route');
    const res = await POST(
      new Request('http://localhost/api/agents/conductor/chat', {
        method: 'POST',
        body: JSON.stringify({ message: '@dev how are things?' }),
      }),
      { params: Promise.resolve({ id: 'conductor' }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.routedTo).toBe('dev');
    expect(typeof body.reply).toBe('string');
  });
});

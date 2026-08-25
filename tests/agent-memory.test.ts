import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  embed,
  localRecall,
  memoriesToPromptBlock,
  recallMemories,
  rememberTurn,
  type AgentMemory,
} from '@/lib/agents/memory';
import type { AgentMessage } from '@/lib/schemas';

// A fresh chainable query-builder mock per call, keyed by which terminal
// method resolves it — mirrors supabase-js's own thenable builder shape.
function makeQueryBuilder(resultsByTerminal: Record<string, { data?: unknown; error?: unknown }>) {
  let terminal = 'select';
  const builder: any = {};
  for (const passthrough of ['select', 'eq', 'order', 'limit']) {
    builder[passthrough] = () => builder;
  }
  builder.insert = () => {
    terminal = 'insert';
    return builder;
  };
  builder.update = () => {
    terminal = 'update';
    return builder;
  };
  builder.maybeSingle = () => {
    terminal = 'maybeSingle';
    return builder;
  };
  builder.single = () => {
    terminal = 'single';
    return builder;
  };
  builder.then = (resolve: any, reject: any) =>
    Promise.resolve(resultsByTerminal[terminal] ?? { data: null, error: null }).then(resolve, reject);
  return builder;
}

const msg = (over: Partial<AgentMessage> = {}): AgentMessage => ({
  id: over.id ?? 'm1',
  agentId: 'data-agent',
  role: 'user',
  content: 'placeholder',
  toolCalls: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('embed', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns null with no OpenAI key configured — never fabricates a vector', async () => {
    // Explicit empty string (not undefined) so this never falls through to
    // reading real credential files on the machine running the test.
    expect(await embed('hello', { OPENAI_API_KEY: '' })).toBeNull();
  });

  test('returns null when the API call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await embed('hello', { OPENAI_API_KEY: 'sk-test' })).toBeNull();
  });

  test('returns the embedding vector on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) }),
    );
    const vector = await embed('hello', { OPENAI_API_KEY: 'sk-test' });
    expect(vector).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('localRecall', () => {
  test('matches recent messages sharing a query term, most recent first', () => {
    const history = [
      msg({ id: 'a', content: 'the Q3 pricing plan is finalized' }),
      msg({ id: 'b', content: 'unrelated weather update' }),
      msg({ id: 'c', content: 'revisit pricing before launch' }),
    ];
    const hits = localRecall(history, 'what was our pricing decision?');
    expect(hits.map((h) => h.id)).toEqual(['c', 'a']);
    expect(hits[0].metadata.source).toBe('sqlite-local-fallback');
  });

  test('short/empty queries return nothing rather than everything', () => {
    expect(localRecall([msg()], 'ok a')).toEqual([]);
  });

  test('respects the limit', () => {
    const history = Array.from({ length: 10 }, (_, i) => msg({ id: `m${i}`, content: 'pricing update' }));
    expect(localRecall(history, 'pricing', 3)).toHaveLength(3);
  });
});

describe('rememberTurn', () => {
  test('returns false with no Supabase client configured', async () => {
    expect(await rememberTurn('data-agent', 'hello', { env: {} })).toBe(false);
  });

  test('returns false when embeddings are unavailable, even with a client', async () => {
    const client = { from: () => makeQueryBuilder({ insert: { error: null } }) } as any;
    expect(await rememberTurn('data-agent', 'hello', { client, env: { OPENAI_API_KEY: '' } })).toBe(false);
  });

  test('writes the memory and returns true on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) }),
    );
    const client = { from: () => makeQueryBuilder({ insert: { error: null } }) } as any;
    const ok = await rememberTurn('data-agent', 'hello', { client, env: { OPENAI_API_KEY: 'sk-test' } });
    expect(ok).toBe(true);
    vi.unstubAllGlobals();
  });

  test('returns false when the insert itself errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1] }] }) }),
    );
    const client = { from: () => makeQueryBuilder({ insert: { error: { message: 'nope' } } }) } as any;
    const ok = await rememberTurn('data-agent', 'hello', { client, env: { OPENAI_API_KEY: 'sk-test' } });
    expect(ok).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('recallMemories', () => {
  test('falls back to the local recall when no client is configured', async () => {
    const local: AgentMemory[] = [
      { id: 'x', agentId: 'a', userId: null, content: 'fallback hit', metadata: {}, createdAt: 't' },
    ];
    const out = await recallMemories('data-agent', 'q', { env: {}, localFallback: () => local });
    expect(out).toEqual(local);
  });

  test('falls back to local recall when embeddings are unavailable', async () => {
    const client = { rpc: vi.fn() } as any;
    const local: AgentMemory[] = [
      { id: 'x', agentId: 'a', userId: null, content: 'fallback hit', metadata: {}, createdAt: 't' },
    ];
    const out = await recallMemories('data-agent', 'q', {
      client,
      env: { OPENAI_API_KEY: '' },
      localFallback: () => local,
    });
    expect(out).toEqual(local);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  test('maps RPC rows to AgentMemory on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1] }] }) }),
    );
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'mem-1',
            agent_id: 'data-agent',
            user_id: null,
            content: 'past insight',
            metadata: { tag: 'x' },
            created_at: 't',
            similarity: 0.87,
          },
        ],
        error: null,
      }),
    } as any;
    const out = await recallMemories('data-agent', 'q', { client, env: { OPENAI_API_KEY: 'sk-test' } });
    expect(out).toEqual([
      { id: 'mem-1', agentId: 'data-agent', userId: null, content: 'past insight', metadata: { tag: 'x' }, createdAt: 't', similarity: 0.87 },
    ]);
    expect(client.rpc).toHaveBeenCalledWith('match_agent_memories', {
      query_embedding: [0.1],
      match_agent_id: 'data-agent',
      match_count: 5,
    });
    vi.unstubAllGlobals();
  });

  test('falls back to local recall when the RPC errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1] }] }) }),
    );
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }) } as any;
    const local: AgentMemory[] = [
      { id: 'x', agentId: 'a', userId: null, content: 'fallback hit', metadata: {}, createdAt: 't' },
    ];
    const out = await recallMemories('data-agent', 'q', { client, env: { OPENAI_API_KEY: 'sk-test' }, localFallback: () => local });
    expect(out).toEqual(local);
    vi.unstubAllGlobals();
  });
});

describe('memoriesToPromptBlock', () => {
  test('empty list renders nothing', () => {
    expect(memoriesToPromptBlock([])).toBe('');
  });

  test('renders a bulleted block callers can safely append', () => {
    const block = memoriesToPromptBlock([
      { id: '1', agentId: 'a', userId: null, content: 'remember this', metadata: {}, createdAt: 't' },
    ]);
    expect(block).toContain('remember this');
    expect(block).toMatch(/^Relevant memory from past conversations:/);
  });
});

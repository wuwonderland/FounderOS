/**
 * Long-term agent memory — augments (never replaces) the sqlite rolling
 * chat transcript (`db.agentMessages`, see lib/agents/chat.ts). Backed by
 * Supabase pgvector (`agent_memories`, supabase/migrations/0002 + 0003) so an
 * agent can recall relevant context from *past* conversations, not just the
 * current one. Every function here is best-effort: no Supabase config, no
 * OpenAI key, or a failed call all degrade to "skip this turn" rather than
 * throwing — chat must keep working exactly as it does today when Supabase
 * isn't set up. See supabase/migrations/README.md for the Route A decision.
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseClient, type SupabaseEnv } from '@/lib/connectors/supabase';
import { CRED_FILES, resolveCred } from '@/lib/creds';
import type { AgentMessage } from '@/lib/schemas';

export type AgentMemory = {
  id: string;
  agentId: string;
  userId: string | null;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  similarity?: number;
};

const EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536 dims — matches supabase/migrations/0002
const EMBEDDING_INPUT_CAP = 8000; // characters; keeps the request well under the model's token limit

function resolveOpenAIKey(env: SupabaseEnv): string | undefined {
  return env.OPENAI_API_KEY ?? resolveCred('OPENAI_API_KEY', [CRED_FILES.agentsEnv]);
}

/** Embeds text via OpenAI's embeddings endpoint. Returns null — never
 *  throws — when no key is configured or the call fails; callers treat null
 *  as "skip semantic memory this turn". */
export async function embed(text: string, env: SupabaseEnv = process.env): Promise<number[] | null> {
  const key = resolveOpenAIKey(env);
  if (!key) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, EMBEDDING_INPUT_CAP) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { embedding?: number[] }[] };
    const vector = body.data?.[0]?.embedding;
    return Array.isArray(vector) ? vector : null;
  } catch {
    return null;
  }
}

export type RememberOpts = {
  userId?: string;
  metadata?: Record<string, unknown>;
  env?: SupabaseEnv;
  client?: SupabaseClient;
};

/** Best-effort long-term memory write. Returns whether it actually landed in
 *  Supabase — callers should never branch app behavior on this beyond
 *  logging; the sqlite rolling history already has the turn either way. */
export async function rememberTurn(agentId: string, content: string, opts: RememberOpts = {}): Promise<boolean> {
  const env = opts.env ?? process.env;
  const client = opts.client ?? supabaseClient(env);
  if (!client) return false;
  const vector = await embed(content, env);
  if (!vector) return false;
  const { error } = await client.from('agent_memories').insert({
    id: randomUUID(),
    agent_id: agentId,
    user_id: opts.userId ?? null,
    content,
    embedding: vector,
    metadata: opts.metadata ?? {},
  });
  return !error;
}

/** Naive local fallback when Supabase/embeddings aren't available: the most
 *  recent messages whose content shares a token with the query, newest
 *  first. Not semantic search — just enough to degrade gracefully instead of
 *  losing all long-term context. */
export function localRecall(history: AgentMessage[], query: string, limit = 5): AgentMemory[] {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return [];
  const hits = history.filter((m) => {
    const lower = m.content.toLowerCase();
    return terms.some((t) => lower.includes(t));
  });
  return hits
    .slice(-limit)
    .reverse()
    .map((m) => ({
      id: m.id,
      agentId: m.agentId,
      userId: null,
      content: m.content,
      metadata: { role: m.role, source: 'sqlite-local-fallback' },
      createdAt: m.createdAt,
    }));
}

export type RecallOpts = {
  limit?: number;
  env?: SupabaseEnv;
  client?: SupabaseClient;
  /** Called when Supabase/embeddings aren't available or the RPC errors. */
  localFallback?: () => AgentMemory[];
};

/** Best-effort semantic recall via the `match_agent_memories` RPC
 *  (supabase/migrations/0003). Falls back to `opts.localFallback` — normally
 *  `localRecall` over the sqlite rolling history — when Supabase or the
 *  embedding call aren't available, so a chat turn never loses all context
 *  just because Supabase isn't configured. */
export async function recallMemories(agentId: string, query: string, opts: RecallOpts = {}): Promise<AgentMemory[]> {
  const env = opts.env ?? process.env;
  const limit = opts.limit ?? 5;
  const client = opts.client ?? supabaseClient(env);
  const vector = client ? await embed(query, env) : null;

  if (client && vector) {
    const { data, error } = await client.rpc('match_agent_memories', {
      query_embedding: vector,
      match_agent_id: agentId,
      match_count: limit,
    });
    if (!error && Array.isArray(data)) {
      return data.map(
        (row: any): AgentMemory => ({
          id: row.id,
          agentId: row.agent_id ?? agentId,
          userId: row.user_id ?? null,
          content: row.content,
          metadata: row.metadata ?? {},
          createdAt: row.created_at,
          similarity: typeof row.similarity === 'number' ? row.similarity : undefined,
        }),
      );
    }
  }

  return opts.localFallback ? opts.localFallback() : [];
}

/** Renders recalled memories as a system-prompt block, or '' when there's
 *  nothing to add — callers can always safely append this. */
export function memoriesToPromptBlock(memories: AgentMemory[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map((m) => `- ${m.content}`).join('\n');
  return `Relevant memory from past conversations:\n${lines}`;
}

/**
 * Supabase connector — backs the `agent_memories` (pgvector long-term agent
 * recall, see lib/agents/memory.ts) and `users` (CRM, see lib/crm/users.ts)
 * tables from supabase/migrations/. Route A (2026-08-20): Supabase + pgvector
 * augments the existing sqlite data model, it doesn't replace it — the
 * rolling agent chat history in data/founder-os.db stays the source of
 * truth; Supabase adds semantic long-term recall and a real CRM users table
 * on top. See supabase/migrations/README.md for the migration + setup steps.
 *
 * Server-only: SUPABASE_SERVICE_ROLE_KEY bypasses row-level security and
 * must never reach the client bundle. Every caller in this repo runs in a
 * server component, route handler, or connector — never import this from
 * client ("use client") code.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ConnectorStatus } from '@/lib/connectors/types';

// supabase-js always constructs a RealtimeClient, even though this app only
// ever uses REST-style .from()/.rpc() calls — never subscriptions. On
// Node < 22 (no native `WebSocket` global) that constructor throws unless a
// transport is supplied, so `ws` covers it here. Cheap either way: the
// RealtimeClient never actually opens a socket unless something calls
// `.channel(...).subscribe()`, which nothing in this repo does.
import WebSocketTransport from 'ws';

export type SupabaseEnv = Record<string, string | undefined>;

function resolveConfig(env: SupabaseEnv): { url: string; key: string } | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

// Cached by (url, key) so repeated calls within a process reuse one client
// instead of opening a new one per request — mirrors the pattern other
// connectors use for their SDK clients (e.g. lib/connectors/notion.ts).
let cached: { url: string; key: string; client: SupabaseClient } | null = null;

export function supabaseClient(env: SupabaseEnv = process.env): SupabaseClient | null {
  const config = resolveConfig(env);
  if (!config) return null;
  if (cached && cached.url === config.url && cached.key === config.key) return cached.client;
  const client = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: typeof globalThis.WebSocket === 'undefined' ? { transport: WebSocketTransport as never } : undefined,
  });
  cached = { ...config, client };
  return client;
}

export async function supabaseStatus(
  env: SupabaseEnv = process.env,
  clientOverride?: SupabaseClient,
): Promise<ConnectorStatus> {
  const base = { id: 'supabase', name: 'Supabase', kind: 'database' } as const;
  const client = clientOverride ?? supabaseClient(env);
  if (!client) {
    return {
      ...base,
      state: 'not_configured',
      detail: 'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.',
    };
  }
  try {
    const { error, count } = await client.from('users').select('id', { count: 'exact', head: true });
    if (error) {
      // 42P01 = undefined_table — keys are good, migrations just haven't run yet.
      const migrationsPending = error.code === '42P01' || /relation .* does not exist/i.test(error.message);
      return {
        ...base,
        state: 'error',
        detail: migrationsPending
          ? 'Connected, but public.users does not exist yet — run supabase/migrations/0001–0003 in the SQL Editor (see supabase/migrations/README.md).'
          : `Keys set but query failed: ${error.message}`,
      };
    }
    return {
      ...base,
      state: 'connected',
      detail: `Connected · public.users reachable${typeof count === 'number' ? ` (${count} rows)` : ''}`,
    };
  } catch (err) {
    return { ...base, state: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

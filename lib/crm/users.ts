/**
 * CRM users — reads/writes Supabase `public.users` (supabase/migrations/
 * 0001_create_users_table.sql). This augments the existing CRM surface
 * (Attio, lib/connectors/attio.ts drives the roster/deals view) rather than
 * replacing it: Attio stays the pipeline/deals source; this table is a
 * lightweight identity record (email + metadata) other parts of the app —
 * agent memory attribution, future auth, etc. — can key off. Every function
 * returns null/[] (never throws) when Supabase isn't configured or a call
 * fails, matching this repo's "never fake success" convention for
 * connectors. See supabase/migrations/README.md for the Route A decision.
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseClient, type SupabaseEnv } from '@/lib/connectors/supabase';

export type CrmUser = {
  id: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type CallOpts = { env?: SupabaseEnv; client?: SupabaseClient };

function resolveClient(opts: CallOpts): SupabaseClient | null {
  return opts.client ?? supabaseClient(opts.env ?? process.env);
}

function mapRow(row: any): CrmUser {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name ?? null,
    avatarUrl: row.avatar_url ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Looks up a user by email, creating one if none exists. Returns null when
 *  Supabase isn't configured or the call fails — callers should treat that
 *  as "CRM lookup unavailable", not "no such user". */
export async function getOrCreateUser(
  email: string,
  opts: CallOpts & { fullName?: string; metadata?: Record<string, unknown> } = {},
): Promise<CrmUser | null> {
  const client = resolveClient(opts);
  if (!client) return null;

  const { data: existing, error: findErr } = await client.from('users').select('*').eq('email', email).maybeSingle();
  if (findErr) return null;
  if (existing) return mapRow(existing);

  const { data: created, error: insertErr } = await client
    .from('users')
    .insert({ id: randomUUID(), email, full_name: opts.fullName ?? null, metadata: opts.metadata ?? {} })
    .select('*')
    .single();
  if (insertErr || !created) return null;
  return mapRow(created);
}

/** Most recently created users first. Empty array on any failure. */
export async function listUsers(opts: CallOpts & { limit?: number } = {}): Promise<CrmUser[]> {
  const client = resolveClient(opts);
  if (!client) return [];
  const { data, error } = await client
    .from('users')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 50);
  if (error || !data) return [];
  return data.map(mapRow);
}

/** Shallow-merges `patch` into the user's existing metadata jsonb column. */
export async function updateUserMetadata(
  id: string,
  patch: Record<string, unknown>,
  opts: CallOpts = {},
): Promise<CrmUser | null> {
  const client = resolveClient(opts);
  if (!client) return null;

  const { data: existing, error: findErr } = await client.from('users').select('metadata').eq('id', id).maybeSingle();
  if (findErr || !existing) return null;

  const merged = { ...(existing.metadata ?? {}), ...patch };
  const { data: updated, error: updateErr } = await client
    .from('users')
    .update({ metadata: merged })
    .eq('id', id)
    .select('*')
    .single();
  if (updateErr || !updated) return null;
  return mapRow(updated);
}

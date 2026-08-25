# Supabase migrations — Route A (approved 2026-08-20)

Supabase + pgvector is wired into the app now. Decisions this repo previously
left open are resolved as follows:

- **Relationship to sqlite**: `agent_memories` and `users` **augment** the
  existing sqlite data model (`data/founder-os.db`, `lib/db.ts`) — they don't
  replace it. The rolling per-agent chat transcript (`db.agentMessages`,
  `lib/agents/chat.ts`) stays the source of truth for a conversation;
  `agent_memories` adds long-term semantic recall across conversations,
  backed by pgvector. See `lib/agents/memory.ts`.
- **Which project**: a dedicated project for this app, separate from the
  gbrain-managed Supabase project (`lib/connectors/gbrain.ts` talks to that
  one for the "Second Brain" knowledge store — different purpose, don't
  collide schemas). Point `NEXT_PUBLIC_SUPABASE_URL` /
  `SUPABASE_SERVICE_ROLE_KEY` at your own project.
- **Client + wiring**: `@supabase/supabase-js` is a dependency;
  `lib/connectors/supabase.ts` is the client + connector status (shows up on
  `/integrations`, kind `database`); `lib/agents/memory.ts` and
  `lib/crm/users.ts` are the application-logic layer. Every function is
  best-effort and never fakes success — if the env vars aren't set, or the
  migrations below haven't been applied yet, agent chat and any CRM-user
  lookups just degrade to today's sqlite-only behavior instead of erroring.

## Applying the migrations

Three files, run **in order**, against your Supabase project:

1. `0001_create_users_table.sql` — the core CRM `users` table.
2. `0002_enable_pgvector_and_agent_memories.sql` — enables the `vector`
   extension and creates `agent_memories` (1536-dim embeddings — matches
   OpenAI `text-embedding-3-small`, what `lib/agents/memory.ts` calls).
3. `0003_agent_memories_match.sql` — the `match_agent_memories` RPC used for
   similarity search (the JS client can't express `ORDER BY embedding <=>
   query_embedding` directly, only a Postgres function can).

### Option A — Supabase Dashboard SQL Editor (no CLI needed)

1. Open your project at supabase.com/dashboard → **SQL Editor**.
2. Click **New query**, paste the full contents of
   `0001_create_users_table.sql`, click **Run**.
3. Repeat for `0002_enable_pgvector_and_agent_memories.sql`, then
   `0003_agent_memories_match.sql`, in that order (0002 must run before 0003
   — it creates the table 0003's function selects from).
4. Confirm: **Table Editor** should now show `users` and `agent_memories`
   under the `public` schema, and **Database → Extensions** should show
   `vector` enabled.
5. Copy **Project Settings → API → Project URL** into
   `NEXT_PUBLIC_SUPABASE_URL`, and **Project Settings → API → service_role
   secret** into `SUPABASE_SERVICE_ROLE_KEY`, both in `.env.local`.
6. Restart `npm run dev` and check `/integrations` — the Supabase card
   should read "Connected".

### Option B — Supabase CLI

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

### After loading real rows

`agent_memories_embedding_idx` (ivfflat) is created empty in migration 0002.
ivfflat needs rows present to build a useful index — once a meaningful
number of memories exist, run `analyze public.agent_memories;` in the SQL
Editor so query planning picks it up.

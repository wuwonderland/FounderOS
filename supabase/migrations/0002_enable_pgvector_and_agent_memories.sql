-- Long-term vector memory store for agents.
-- NOT wired to any application code yet — see supabase/migrations/README.md.

create extension if not exists vector;

create table if not exists public.agent_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  agent_id text not null,
  content text not null,
  -- 1536 matches OpenAI text-embedding-3-small/ada-002. Change this to match
  -- whichever embedding model actually writes to this table.
  embedding vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agent_memories_agent_id_idx on public.agent_memories (agent_id);
create index if not exists agent_memories_user_id_idx on public.agent_memories (user_id);

-- Approximate nearest-neighbor index. ivfflat needs rows present (and an
-- ANALYZE) to build a useful index — fine to create empty, but re-run
-- `analyze public.agent_memories;` after the first bulk load.
create index if not exists agent_memories_embedding_idx
  on public.agent_memories
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

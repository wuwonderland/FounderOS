-- Cosine-similarity search over agent_memories, exposed as an RPC because
-- supabase-js can't express `ORDER BY embedding <=> query_embedding` through
-- the query builder — only a Postgres function callable via `.rpc(...)` can.
-- Caller: lib/agents/memory.ts `recallMemories`.

create or replace function public.match_agent_memories(
  query_embedding vector(1536),
  match_agent_id text,
  match_count int default 5
)
returns table (
  id uuid,
  agent_id text,
  user_id uuid,
  content text,
  metadata jsonb,
  created_at timestamptz,
  similarity float
)
language sql
stable
as $$
  select
    m.id,
    m.agent_id,
    m.user_id,
    m.content,
    m.metadata,
    m.created_at,
    1 - (m.embedding <=> query_embedding) as similarity
  from public.agent_memories m
  where m.agent_id = match_agent_id
  order by m.embedding <=> query_embedding
  limit greatest(match_count, 0)
$$;

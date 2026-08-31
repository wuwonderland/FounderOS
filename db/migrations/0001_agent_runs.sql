-- Reference schema for the live-agent execution loop (lib/agents/executor.ts).
--
-- IMPORTANT: this file documents the schema; it is NOT executed by
-- anything. FounderOS's sqlite database (data/founder-os.db) has no
-- migration-file runner — unlike supabase/migrations/ (a real Postgres
-- project applied by hand in the Supabase SQL Editor, see
-- supabase/migrations/README.md), every table this app uses is created and
-- evolved directly in lib/db.ts: `DDL` for CREATE TABLE IF NOT EXISTS, and
-- an idempotent `migrateXTable(db)` function (checked via
-- `PRAGMA table_info`, applied with `ALTER TABLE ... ADD COLUMN`) for any
-- column added after a table's first ship. See migrateAgentRunsTable and
-- the `tool_calls` entry in DDL there for the actual, executed source of
-- truth this file mirrors.
--
-- agent_runs already existed before this loop (lib/agents/runtime.ts's
-- simple status-check run(), id/agent_id/started_at/finished_at/ok/summary)
-- — the columns below are additive to that same table, not a new one.
-- `ended_at` in the task spec this file was written against is the same
-- moment `finished_at` already recorded; there's no separate column for it.

-- ALTER TABLE agent_runs ADD COLUMN status       TEXT;    -- 'completed' | 'failed' | 'timeout'
-- ALTER TABLE agent_runs ADD COLUMN step_count    INTEGER;
-- ALTER TABLE agent_runs ADD COLUMN input_tokens  INTEGER;
-- ALTER TABLE agent_runs ADD COLUMN output_tokens INTEGER;
-- ALTER TABLE agent_runs ADD COLUMN error         TEXT;

CREATE TABLE IF NOT EXISTS tool_calls (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES agent_runs(id),
  step        INTEGER NOT NULL,
  tool_name   TEXT NOT NULL,
  args_json   TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  ok          INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0
);

-- S28 — the runtime is a choice, and a fact about the run.
--
-- "The runtime used is recorded on the task, and selectable per project and per
-- task." Two different needs:
--
--   projects.default_runtime  what this project's work runs on unless told
--                             otherwise. Null means the host default.
--   tasks.runtime             what THIS task should run on (the selector), and
--   tasks.ran_on_runtime      what it actually did run on (the fact).
--
-- The last two are deliberately separate. A task can be queued asking for codex
-- and end up parked because codex is not installed; recording the request in the
-- same column as the outcome would make "which engine produced this PR?"
-- unanswerable, and S29's evaluation suite has nothing to compare if the answer
-- is a guess.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS default_runtime text;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS runtime text,
  ADD COLUMN IF NOT EXISTS ran_on_runtime text;

-- Which engine has been doing the work lately, without a scan.
CREATE INDEX IF NOT EXISTS tasks_ran_on_runtime
  ON tasks (ran_on_runtime, updated_at DESC)
  WHERE ran_on_runtime IS NOT NULL;

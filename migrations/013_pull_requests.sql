-- S7: the pull request a task produced.
--
-- Recorded on the task so that opening one is idempotent. "The same task run
-- twice must not open two pull requests" is not a nicety: a retried run, a
-- watchdog recovery, or a resumed attempt all re-enter the same code path, and
-- without a recorded number the second one opens a duplicate that a human then
-- has to reconcile.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pr_number integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pr_url text;

CREATE INDEX IF NOT EXISTS tasks_pr ON tasks (pr_number) WHERE pr_number IS NOT NULL;

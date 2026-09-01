-- S6: the engineering workflow, phase by phase.
--
-- task_events already carried tool/test/git/review/log. What it could not say is
-- "the run is now at the root-cause phase" — and without that the console cannot
-- show the loop, and a killed run cannot resume at the phase it reached instead
-- of starting over. Both are S6 requirements and both need the same row.

ALTER TABLE task_events DROP CONSTRAINT IF EXISTS task_events_type_check;
ALTER TABLE task_events
  ADD CONSTRAINT task_events_type_check
  CHECK (type IN ('tool', 'test', 'git', 'review', 'log', 'phase'));

-- The phase a task has reached. Nullable because system-lane tasks and the
-- Supervisor do not have phases; only the engineering loop does.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS phase text;

-- The run's own verdict, kept separately from the state machine.
--
-- "It exited 0" and "it fixed the bug" are different claims, and conflating them
-- is how a guess gets recorded as a fix. The harness writes this; the runner
-- refuses to call a task succeeded when it says the work was not done.
ALTER TABLE task_attempts ADD COLUMN IF NOT EXISTS reproduced boolean;
ALTER TABLE task_attempts ADD COLUMN IF NOT EXISTS verdict text;
ALTER TABLE task_attempts ADD COLUMN IF NOT EXISTS confidence text;

CREATE INDEX IF NOT EXISTS task_events_phase
  ON task_events (task_id, at) WHERE type = 'phase';

-- S34: one fire per (schedule, minute), enforced rather than hoped for.
--
-- The worker already keyed idempotency on (schedule_id, scheduled_for), which
-- is the right key - the plan's Debug note says a duplicate fire after a
-- restart means idempotency is keyed on something ELSE. But it enforced it with
-- a SELECT followed by an INSERT, and that is a convention, not a constraint:
-- two workers, or one worker restarted between the two statements, both see no
-- row and both insert one. The window is small and the failure is a task that
-- ran twice, which for a schedule that deploys or sends something is not a
-- small failure.
--
-- A partial index, because `scheduled_for` is nullable on this table: a run
-- created from an inbox event rather than from the clock has no scheduled
-- minute, and several of those are not a conflict.
CREATE UNIQUE INDEX IF NOT EXISTS schedule_runs_once_per_minute
  ON schedule_runs (schedule_id, scheduled_for)
  WHERE scheduled_for IS NOT NULL;

-- What happened, so a schedule that stopped firing can be explained.
-- 'fired' | 'skipped_overlap' | 'skipped_misfire' | 'error'
COMMENT ON COLUMN schedule_runs.result IS
  'S34: fired | skipped_overlap | skipped_misfire | error. A skip is recorded, or a schedule that never runs looks identical to one that was never due.';

-- A run's failures belong in its own record.
--
-- Both runtimes already normalise an error event, and the runner dropped them:
-- task_events held a run's successes and nothing else, so a clean run and one
-- that failed half its commands were indistinguishable afterwards. S29 scores
-- tool_reliability from exactly that difference, and could not.
--
-- This widens the event vocabulary by one value. It is not the issue taxonomy -
-- categories, severities and notification levels are untouched - it is the
-- runner's own event log, whose existing values are tool/test/git/review/log/
-- phase/recovery.
ALTER TABLE task_events DROP CONSTRAINT IF EXISTS task_events_type_check;
ALTER TABLE task_events ADD CONSTRAINT task_events_type_check
  CHECK (type = ANY (ARRAY['tool', 'test', 'git', 'review', 'log', 'phase', 'recovery', 'error']));

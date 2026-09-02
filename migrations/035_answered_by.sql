-- Which track actually spoke.
--
-- A turn runs two things at once: tier 1 (no tools, one short line) and the
-- desk (the full Supervisor). Both write `model_ms`, and they measure different
-- spans - tier 1 from the start of the turn, the desk from when the desk began.
-- So the column has always held two different quantities with no way to tell
-- them apart, and a 15-second desk answer was indistinguishable from a
-- 15-second tier-1 answer when reading the table.
--
-- That is not a reporting nicety. The requirement is that a turn carrying no
-- tool call answers in about a second, and until now that could not be asserted
-- at all, because "carrying no tool call" was not recorded. `tool_started_at`
-- does not say it either: it is set unconditionally at the top of every turn to
-- mark the desk track starting, so every turn ever recorded looks like it used
-- a tool.
ALTER TABLE call_turns ADD COLUMN IF NOT EXISTS answered_by text
  CHECK (answered_by IN ('tier1', 'desk', 'handover'));

COMMENT ON COLUMN call_turns.answered_by IS
  'Which track produced the spoken answer: tier1 (no tools) or desk (full Supervisor).';

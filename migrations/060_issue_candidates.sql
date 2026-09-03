-- B10: the count that has to exist before the Issue does.
--
-- Enrique's decision (2026-09-03) gives `resource.cpu` the position "severity
-- warning, notify ui_only (Issue if sustained)". The parenthesis is the part
-- with no home in the existing schema. An Issue carries its own occurrence
-- count, and `raiseIssue` bumps it on every recurrence - but that only works
-- once an Issue exists, and "if sustained" is precisely the decision about
-- whether to create one. Nothing was counting the run-up.
--
-- So the count lives BESIDE the Issue list rather than in it. The cheaper
-- alternative - insert the Issue with a `suppressed` status and promote it later
-- - would have put the row on the list it is being kept off, and every consumer
-- of `issues` would then need to know about a status that means "not really".
--
-- Machines are briefly busy. A busy machine is not a defect and an Issue per
-- spike is a list nobody reads; a machine that has been busy for a quarter of an
-- hour is a different claim about the world.
CREATE TABLE IF NOT EXISTS issue_candidates (
  -- The same key the Issue would be deduped by, so the promotion is a lookup
  -- rather than a correlation.
  dedupe_key text PRIMARY KEY,
  category text NOT NULL,
  occurrences integer NOT NULL DEFAULT 1,

  -- When this EPISODE started, not when the category was first ever seen. A gap
  -- longer than the window restarts both the count and this timestamp.
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Candidates that stopped recurring are dead weight; sweeping them is a
-- last_seen_at scan.
CREATE INDEX IF NOT EXISTS issue_candidates_stale ON issue_candidates (last_seen_at);

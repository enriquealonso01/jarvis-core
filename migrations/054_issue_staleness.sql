-- S33: what happens when he does not act.
--
-- "Jarvis raises an Issue, sends one message, and then - by design - says
-- nothing more. The plan never says what happens if he does not act." S46 says
-- "never authenticate -> it stays parked with a truthful reason and does not
-- nag", which is exactly right for an auth handoff and, "written as a general
-- principle, is wrong, because the first implementation will apply it to
-- everything, including the backup that has been failing for a month."
--
-- The distinction is NOT how important the Issue is. It is whether waiting
-- costs anything:
--
--   wait      waiting on his choice costs nothing - an auth handoff, a proposed
--             capability, an approval he has not got to. The park IS the correct
--             end state, and these never nag.
--   re-raise  waiting while degrading costs more every day - a failing backup,
--             an expiring credential, a disk trending full. "Silence for a week
--             is how you discover the backups were broken on the day you needed
--             one."
--   block     waiting is not acceptable at all - isolation and data loss. S12
--             already stops other work until a cross-project probe is closed;
--             this names that behaviour so it is not the only class that has it.
ALTER TABLE issues
  ADD COLUMN IF NOT EXISTS staleness text
    CHECK (staleness IN ('wait', 're-raise', 'block')),
  -- When it was last put in front of him again. NULL means never re-raised,
  -- which for a fortnight-old re-raise issue is itself the bug.
  ADD COLUMN IF NOT EXISTS last_reraised_at timestamptz,
  -- How many times the underlying condition has recurred since the last time he
  -- saw it. "Backup has failed 9 times since the 12th" is a different sentence
  -- from the one he already ignored once.
  ADD COLUMN IF NOT EXISTS occurrences_at_last_raise integer NOT NULL DEFAULT 0;

-- Needs You is read by age, never by recency: "the oldest unresolved item is by
-- definition the one being ignored, and putting it last is how it stays that
-- way."
CREATE INDEX IF NOT EXISTS issues_needs_you_age
  ON issues (created_at)
  WHERE status NOT IN ('resolved', 'ignored');

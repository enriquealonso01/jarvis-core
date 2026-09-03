-- S34: the weekly Improvement scan, and the thing it must never do.
--
-- "Force an Improvement run and confirm NOTHING ACTIVATES ITSELF." A scan that
-- can enact its own suggestions is not a scan, and the failure is quiet: the
-- system that proposed a change and made it is indistinguishable, a week later,
-- from one that was asked to.
--
-- The other half is not nagging. "Decline a candidate, then run the scan again
-- -> it does not come back. Change its version and run again -> it returns, and
-- the message names what changed rather than repeating the pitch."
--
-- So a decline is pinned to a FINGERPRINT of what was proposed, exactly as S31
-- pins a tool's classification to its manifest rather than to a version string,
-- and for the same reason: a candidate that says it is unchanged is the party
-- being gated. Staleness is derived from the comparison rather than maintained,
-- so a changed proposal returns on its own and nothing has to remember to
-- un-decline it.
CREATE TABLE IF NOT EXISTS improvement_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable identity across scans: what the suggestion is ABOUT.
  candidate_key text NOT NULL UNIQUE,
  title text NOT NULL,
  -- What it would do, in his words on the console.
  pitch text NOT NULL,
  -- sha256 over the proposal. Two scans of an unchanged system agree.
  fingerprint text NOT NULL,

  -- proposed | declined | approved
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'declined', 'approved')),
  -- The fingerprint he declined. A candidate is silent while this still
  -- matches; when the proposal changes, the mismatch brings it back by itself.
  declined_fingerprint text,
  declined_at timestamptz,
  -- Set on approval. "One-tap approval that produces no work is a button, not a
  -- decision", so this column is the evidence that the tap did something.
  approved_task_id uuid REFERENCES tasks (id),
  approved_at timestamptz,

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  times_seen integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS improvement_open
  ON improvement_candidates (last_seen_at DESC)
  WHERE status = 'proposed';

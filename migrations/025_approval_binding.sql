-- S12b item 6: Level 3 re-authentication, and an approval that binds to what it
-- approved (Part V).
--
-- Approving an always-confirm action asked for nothing but a live session. The
-- plan calls for the ordinary "sudo moment": the password again, with a short
-- grace window so a sequence of related approvals does not become theatre.
--
-- And "approve" clicked against a stale screen is the failure mode that produces
-- the wrong outcome with a complete audit trail saying it was authorised. So the
-- approval carries a hash of the specific action, its arguments and the state
-- they were computed against; if the page has moved on, the click is refused and
-- re-presented rather than applied to whatever is current now.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS binding_sha text;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS requires_reauth boolean NOT NULL DEFAULT false;

-- When the operator last proved they are still there. One row per session, so a
-- re-auth in one browser does not silently authorise another.
CREATE TABLE IF NOT EXISTS reauth_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reauth_recent ON reauth_events (session_id, at DESC);

-- A per-hour ceiling on Level 3 approvals: "high enough never to be noticed in
-- normal use, low enough that a compromised session cannot empty the budget".
-- Counted from the audit trail rather than a counter that can drift out of step
-- with what actually happened.

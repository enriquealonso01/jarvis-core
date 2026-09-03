-- A connection is a set of permitted actions, not a switch (plan S31).
--
-- "Project A may use Composio" is not the same statement as "project A may send
-- email as Enrique", and one Composio connection is a gateway to hundreds of
-- services. Treating the connection as a boolean collapses those two sentences
-- into one, and the collapsed version is the permissive one.
--
-- Fail closed, and note what that costs: a connection with no rows here permits
-- NOTHING. That is deliberate - an empty allowlist meaning "everything" is the
-- exact bug already fixed twice in this system, once for auth_profile_allowlists
-- and once for connection_project_allowlist - but it does mean every existing
-- connection is inert until its actions are declared. That is the correct
-- direction for the mistake to run.

CREATE TABLE IF NOT EXISTS connection_actions (
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  -- The action as the adapter names it: "github.create_issue", "read_file".
  -- Scoped to the service where the vendor has one, because "create_issue"
  -- alone does not say on which service it creates the issue.
  action text NOT NULL,
  -- Level 1 safe / 2 per project policy / 3 always-confirm (IV.6), decided by a
  -- person when the connection is attached and stored here rather than judged
  -- at call time - at call time all you have is a name.
  level int NOT NULL DEFAULT 3 CHECK (level BETWEEN 1 AND 3),
  -- What the classification was made against, so a changed tool re-opens it.
  -- Names, descriptions and schemas together: a self-reported version is
  -- authored by the same party as the tool.
  manifest_hash text,
  classified_by text,
  classified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, action)
);

CREATE INDEX IF NOT EXISTS connection_actions_conn_idx
  ON connection_actions (connection_id);

-- S31: blast radius is classified at attach time, by a person, once.
--
-- "Not at call time: at call time all you have is a name, and `update_record`
-- tells you nothing about whether the record is in a staging database or a
-- customer's billing account."
--
-- Two things here are deliberately not what the plan's prose first suggests.
--
-- FIRST, the classification is pinned to a HASH OF THE TOOL MANIFEST, not to
-- the server's version string. The plan says why and it is the sharper point:
-- the version is authored by the same party as the tool, and many servers
-- return descriptions dynamically at list time without ever changing it.
-- Pinning to a self-reported version is trusting the changelog of whoever you
-- are gating.
--
-- SECOND, staleness is DERIVED rather than maintained. `classified_hash` is the
-- manifest the level was decided against; a tool is callable only while it
-- still equals `manifest_hash`. Nothing has to remember to re-open a
-- classification when a description changes - the comparison simply stops
-- matching, and the tool goes inert on its own. A rule that depends on somebody
-- calling a re-open function is a rule that holds until the day the sync path
-- takes a shortcut. It also keeps what the level WAS, which a null-it-out
-- design destroys.
CREATE TABLE IF NOT EXISTS connection_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  name text NOT NULL,

  -- Authored by the server's author, stored so the classifier can read it.
  -- It is a CLAIM, not a specification (IV.6b): it is rendered as untrusted
  -- text and never assembled into anything's instructions.
  description text,
  input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- sha256 over name + description + schema, canonically encoded.
  manifest_hash text NOT NULL,

  -- IV.6: 1 safe, 2 per project policy, 3 always-confirm.
  -- NULL means unclassified, and an unclassified tool is not callable - the
  -- server is attached and inert.
  level integer CHECK (level IN (1, 2, 3)),
  classified_hash text,
  classified_at timestamptz,
  classified_by text,

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, name)
);

CREATE INDEX IF NOT EXISTS connection_tools_conn ON connection_tools (connection_id);
-- What the Connections tab asks for: what is attached and still waiting on me.
CREATE INDEX IF NOT EXISTS connection_tools_unclassified ON connection_tools (connection_id)
  WHERE level IS NULL;

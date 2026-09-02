-- S17: an output is an object with a history, not a file attached to a log.
--
-- Until now an artifact was a path, some bytes and a retention class. That is
-- enough to keep a file and not enough to review one: there was nowhere to say
-- what kind of thing it is, whether Enrique has looked at it, what he said,
-- which version it replaced, or whether it has actually been delivered as
-- opposed to merely approved.
--
-- `supersedes_id` is the load-bearing one. The plan is explicit that a second
-- attempt at the same output must not silently orphan the first: an artifact
-- overwritten in place has destroyed the evidence that made review possible, and
-- no amount of UI recovers it.

ALTER TABLE artifacts
  -- pull_request | commit | patch | report | document | spreadsheet |
  -- screenshot | dataset | download | test_report | recording | deployment_url
  ADD COLUMN IF NOT EXISTS artifact_type text NOT NULL DEFAULT 'download',
  -- draft -> generated -> under_review -> ready -> approved -> delivered,
  -- with rejected and superseded as the two exits.
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'generated',
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES artifacts(id),
  ADD COLUMN IF NOT EXISTS reviewer_notes text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  -- Delivery is NOT approval. Something can be approved and not yet delivered,
  -- and a console that implies otherwise is lying about where the work is.
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_target text,
  -- Provenance, recorded AT REGISTRATION. The plan's Debug section is blunt
  -- about this: "provenance written later is provenance that will sometimes be
  -- missing."
  ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES tasks(id),
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id),
  ADD COLUMN IF NOT EXISTS created_by_agent text,
  ADD COLUMN IF NOT EXISTS created_by_model text,
  ADD COLUMN IF NOT EXISTS created_by_harness text,
  ADD COLUMN IF NOT EXISTS created_by_auth_profile text,
  -- For a deployment URL or a pull request there is no file; the artifact IS
  -- the address. `path` stays required, so it holds the same value and this
  -- says it is a link rather than something to download.
  ADD COLUMN IF NOT EXISTS external_url text;

CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS artifacts_state ON artifacts (state);
CREATE INDEX IF NOT EXISTS artifacts_supersedes ON artifacts (supersedes_id)
  WHERE supersedes_id IS NOT NULL;
-- The version history of one lineage is read constantly by the artifact page.
CREATE INDEX IF NOT EXISTS artifacts_lineage ON artifacts (project_id, path, version);

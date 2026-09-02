-- S27 — configuration by conversation.
--
-- "A spoken instruction changes another project's AGENTS.md, and the change is
-- versioned WITH THE CONVERSATION THAT CAUSED IT." A version row that records
-- what changed but not what asked for it cannot answer "why is Alpha like
-- this?", which is most of the value of keeping the history at all.
--
-- Both version tables get the same provenance, because a config change and an
-- instructions change are the same act from Enrique's side: he said a sentence.

ALTER TABLE config_versions
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations (id),
  ADD COLUMN IF NOT EXISTS caused_by_message text,
  -- The version this one replaced, so a rollback is a fact rather than an
  -- inference from ordering. Null on the first version of a key.
  ADD COLUMN IF NOT EXISTS supersedes uuid REFERENCES config_versions (id);

ALTER TABLE project_instructions_versions
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations (id),
  ADD COLUMN IF NOT EXISTS caused_by_message text;

-- History is asked by key and by project ("what changed in Alpha's policy last
-- week?"), and always newest-first.
CREATE INDEX IF NOT EXISTS config_versions_project_at
  ON config_versions (project_id, at DESC);
CREATE INDEX IF NOT EXISTS config_versions_key_at
  ON config_versions (key, at DESC);

-- `version` was unique per key only by convention, and the existing writer
-- computed it with max(version) over the whole key regardless of project — so
-- two projects sharing a key name shared a version sequence. Scope the
-- uniqueness to what it is actually a sequence of.
CREATE UNIQUE INDEX IF NOT EXISTS config_versions_scope_key_version
  ON config_versions (COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid), key, version);

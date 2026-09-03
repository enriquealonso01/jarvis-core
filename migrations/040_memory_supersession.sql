-- S30: a preference can be replaced, and the replaced one stays visible.
--
-- The plan asks for three things that the table could not express:
--
--   * state a preference, contradict it, and the CURRENT one answers;
--   * "forget what I told you about X" - not retrieved afterwards, still
--     present as a superseded record;
--   * the old one remains visible in the audit.
--
-- Deleting the row satisfies the first two and destroys the third, and the
-- third is the one that matters when he asks "did I not tell you the opposite
-- last month?". So a memory is superseded, never removed.
ALTER TABLE memory_items
  -- Which memory replaced this one. NULL for a live memory. Named the same way
  -- artifacts.supersedes_id is, so both supersession stories read alike.
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES memory_items (id),
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  -- Why it stopped applying: 'replaced' when a new statement contradicts it,
  -- 'forgotten' when he asked for it to be dropped. The two read differently in
  -- an audit and only one of them has a replacement to point at.
  ADD COLUMN IF NOT EXISTS superseded_reason text;

-- Retrieval asks for live memories on every question, so the common case should
-- not scan the superseded ones.
CREATE INDEX IF NOT EXISTS memory_items_live_idx
  ON memory_items (project_id) WHERE superseded_at IS NULL;

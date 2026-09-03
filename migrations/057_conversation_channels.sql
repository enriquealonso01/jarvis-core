-- S39: one conversation, whichever surface touched it.
--
-- "A task started on one channel continues on another with its state intact. He
-- should never restate what he was doing because he switched surfaces."
--
-- The Debug note names the failure precisely: "If context is lost across
-- channels, look for a per-channel conversation being created rather than the
-- existing one being joined - that is the same 1:1 modelling mistake IV.0 warns
-- about, arriving by a different route."
--
-- `conversations.channel` already records which surface STARTED a thread, and
-- keeping only that makes the mistake easy: the obvious way to find "his
-- WhatsApp conversation" is to filter on it, and then WhatsApp and the phone
-- have separate memories of the same request. This column records every surface
-- that has touched the thread, which makes the continuity assertable - one row,
-- three channels - rather than inferred from an absence of duplicates.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channels text[] NOT NULL DEFAULT ARRAY[]::text[];

-- Backfill from the starting channel, so an existing thread is not reported as
-- having been touched by nothing.
UPDATE conversations SET channels = ARRAY[channel]
 WHERE channels = ARRAY[]::text[] AND channel IS NOT NULL;

-- Continuity is a lookup on "most recently active for this project", so that is
-- what needs the index. Deliberately NOT keyed on channel: an index by channel
-- is the shape of the bug.
CREATE INDEX IF NOT EXISTS conversations_recent
  ON conversations (project_id, last_activity_at DESC);

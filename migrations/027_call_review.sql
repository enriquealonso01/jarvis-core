-- S24: a call is as reviewable as a chat thread.
--
-- The recording, the transcript and the tasks already existed (S19, S22). What
-- was missing is the thing a person actually reads first — what the call was
-- ABOUT — and any way to find it again from a later call.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS summary text;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_artifact_id uuid REFERENCES artifacts (id);

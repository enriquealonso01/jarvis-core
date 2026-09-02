-- S20: turn-taking. What the caller has said so far, and since when.
--
-- Before this, every `call.transcription` final was a whole turn. Telnyx emits a
-- final per SEGMENT, so "book me a flight to Madrid — no, Barcelona" was two
-- turns, and a natural pause mid-thought ended the caller's turn for them. The
-- utterance is now accumulated here until the caller has been quiet long enough
-- for the turn to be theirs to give up.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS pending_text text;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS pending_since timestamptz;
-- What is currently playing, so barge-in can stop THAT and not a playback that
-- has already finished. Telnyx has no "stop whatever is playing" that is safe to
-- issue blind: a stale stop lands on the next playback and cuts off the answer
-- the caller just asked for.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS speaking_marker text;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS barge_ins integer NOT NULL DEFAULT 0;

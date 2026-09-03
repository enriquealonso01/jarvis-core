-- A notification can be handed to the transport without being delivered.
--
-- The outbox had three states: pending, sent, failed. None of them describes
-- the thing that actually happens most often when a channel is sick - the
-- message was put on the wire, the transport took responsibility for it, and
-- nobody has confirmed anything.
--
-- Recording that as `sent` is what produced the delivery loop of 2026-09-03:
-- 273 rows marked sent, attempts = 1, while OpenClaw was retrying 65 entries
-- about 150 times each. Recording it as `failed` would be just as wrong in the
-- other direction, because `failed` is revived by the sweep in worker.ts and
-- revival is exactly the second retry ladder that has to stop existing.
--
-- So: `handed_off` is terminal for Jarvis. The transport owns retry (II.2c),
-- and the Issue raised alongside it is what keeps the message from being
-- silently lost.

ALTER TABLE notifications_outbox
  DROP CONSTRAINT IF EXISTS notifications_outbox_state_check;

ALTER TABLE notifications_outbox
  ADD CONSTRAINT notifications_outbox_state_check
  CHECK (state = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'handed_off'::text]));

-- S37 step 2: who is allowed to tell Jarvis what to do on WhatsApp.
--
-- `channel_allowlist` has been empty since the beginning, which is why the
-- WhatsApp setup blocker has never closed and why every WhatsApp notification
-- ever queued has sat in `notifications_outbox` unsent.
--
-- `can_command` is the whole point of the table. An identifier that is merely
-- allowlisted may be heard; one with `can_command` may be obeyed. Enrique's
-- number is the only commanding identity there will ever be on this system —
-- plan §0: "Enrique is the only user" — and anything arriving from any other
-- number is inbound content, which S37's untrusted-content rule already handles
-- (migration 032): it can be quoted and stored and can authorise nothing.
--
-- The number is not a secret. It is in site.yaml, in BLOCKED.md and in the
-- evidence for S23; putting it here makes the allowlist reproducible on a
-- rebuild rather than a thing someone has to remember to type.

INSERT INTO channel_allowlist (channel, identifier, display, can_command)
VALUES ('whatsapp', '+13055052646', 'Enrique', true)
ON CONFLICT (channel, identifier) DO UPDATE SET can_command = true;

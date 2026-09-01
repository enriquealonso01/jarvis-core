-- Telnyx as a broker connection, so the API key is pasted in the console
-- rather than typed into a file over SSH.
--
-- Two different secrets, deliberately in two different places:
--   * the API key is secret and goes in the broker, encrypted, like every other
--     provider key;
--   * the webhook signing key is PUBLIC, so it belongs in site.yaml next to the
--     other pinned operator settings (voice_id, the E.164 numbers) — no reason
--     to make a public value require a credential record.

INSERT INTO auth_profiles (id, provider, display_name, owner, billing_owner, auth_type, health)
VALUES ('telnyx', 'telnyx', 'Telnyx', 'Enrique', 'Enrique', 'api_key', 'unknown')
ON CONFLICT (id) DO NOTHING;

INSERT INTO connections (slug, kind, scope, auth_profile_id, health)
VALUES ('telnyx', 'telnyx', 'system', 'telnyx', 'unknown')
ON CONFLICT (slug) DO NOTHING;

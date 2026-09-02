-- The OAuth device flow, in flight (netcup SCP).
--
-- Netcup issues refresh tokens exclusively through Keycloak's device code grant:
-- there is no key to paste. The action request said `oauth_connect` and the only
-- thing behind it stored a pasted string, so the blocker could never be closed
-- from the Control Center at all.
--
-- The `device_code` is the browser's proof-of-nothing: it is the SERVER's half
-- of the exchange and never leaves this table. What the browser is given is the
-- user code and the URL, which are meant to be read aloud and typed in.
CREATE TABLE IF NOT EXISTS oauth_device_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_profile_id text NOT NULL REFERENCES auth_profiles (id),
  device_code text NOT NULL,
  user_code text NOT NULL,
  verification_uri text NOT NULL,
  verification_uri_complete text,
  -- Keycloak's own pacing. Polling faster than this earns a `slow_down`.
  interval_seconds integer NOT NULL DEFAULT 5,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_polled_at timestamptz,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','connected','expired','denied','failed')),
  detail text
);
CREATE INDEX IF NOT EXISTS oauth_device_flows_live
  ON oauth_device_flows (auth_profile_id, state) WHERE state = 'pending';

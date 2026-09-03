-- S32: a saved session is a credential the broker never issued.
--
-- The plan's own framing, and it is the part that is easy to miss: a session
-- Jarvis obtained PROPERLY is still a credential the broker cannot revoke.
-- He signs in through the handoff, the site sets a cookie, and from then on the
-- broker holds a password while the profile directory holds working access.
-- "Those are two different things with two different lifetimes, and only one of
-- them has a lifecycle." This table is the other one.
CREATE TABLE IF NOT EXISTS browser_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id),
  -- Which connection this access belongs to, so revoking that connection can
  -- find the cookie. Without this the broker forgets a password while the
  -- session keeps working, which is the failure the plan names precisely.
  connection_slug text,
  -- One host. A session is access to a site, not to the internet.
  domain text NOT NULL,

  established_at timestamptz NOT NULL DEFAULT now(),
  -- "Sessions age out. A profile holding a login for six months is access
  -- nobody re-consented to." Declared by the connection, not guessed here.
  expires_at timestamptz,
  last_ok_at timestamptz,

  -- live | expired | failed | revoked
  --
  -- `failed` is deliberately not a retry counter. "A session that starts
  -- failing is treated as revoked, not as flaky - he changed his password, or
  -- the site invalidated it, and nothing tells Jarvis, so retrying looks
  -- exactly like a transient error and produces repeated failed logins against
  -- his account."
  state text NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'expired', 'failed', 'revoked')),
  state_reason text,

  UNIQUE (project_id, domain)
);

CREATE INDEX IF NOT EXISTS browser_sessions_project ON browser_sessions (project_id);
CREATE INDEX IF NOT EXISTS browser_sessions_connection ON browser_sessions (connection_slug)
  WHERE connection_slug IS NOT NULL;

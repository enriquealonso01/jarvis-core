-- Issues: dedupe by failure class, not by the id of the thing that failed.
-- The supervisor handler keyed on inbox_event_id, so ten consecutive failures of
-- the same broken route opened ten identical tickets.
ALTER TABLE issues
  ADD COLUMN IF NOT EXISTS occurrences integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS issues_open_status ON issues (status) WHERE status NOT IN ('resolved', 'ignored');

-- Collapse the per-inbox supervisor failures into one class-level ticket and
-- close it: the routing defect behind them is fixed and verified.
WITH agg AS (
  SELECT count(*)::int AS n, max(created_at) AS last_at
  FROM issues
  WHERE category = 'supervisor.fail' AND status NOT IN ('resolved', 'ignored')
)
UPDATE issues i
SET status = 'resolved',
    resolved_at = now(),
    updated_at = now(),
    occurrences = (SELECT n FROM agg),
    last_seen_at = (SELECT last_at FROM agg),
    required_action = 'None. Supervisor failover now routes from model_registry and every route is probed live.'
FROM agg
WHERE i.category = 'supervisor.fail' AND i.status NOT IN ('resolved', 'ignored');

UPDATE issues
SET status = 'resolved',
    resolved_at = now(),
    updated_at = now(),
    required_action = 'None. Root cause was dead hardcoded fallback model ids; routing is now registry-driven.'
WHERE category = 'supervisor'
  AND title ILIKE '%supervisor keeps failing%'
  AND status NOT IN ('resolved', 'ignored');

-- Composio: Enrique authorises this himself; seed the profile so it appears on
-- Connections and in "Needs You" instead of being invisible until then.
INSERT INTO auth_profiles (id, provider, display_name, owner, billing_owner, auth_type, metered_spend_allowed, health)
VALUES ('composio', 'composio', 'Composio', 'Enrique', 'Enrique', 'api_key', false, 'unknown')
ON CONFLICT (id) DO NOTHING;

INSERT INTO connections (slug, kind, scope, auth_profile_id)
VALUES ('composio', 'composio', 'system', 'composio')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO issues (severity, category, service, status, owner, title, evidence, required_action, dedupe_key)
SELECT 'medium', 'setup.pending', 'composio', 'waiting_for_user', 'user',
       '[setup] Composio not connected',
       '{"why":"Composio is how Jarvis connects arbitrary third-party tools without a bespoke integration per tool."}'::jsonb,
       'Paste the Composio API key on the Connections page. Jarvis then lists the toolkits available to it and asks before enabling any of them.',
       'setup.composio'
WHERE NOT EXISTS (SELECT 1 FROM issues WHERE dedupe_key = 'setup.composio');

-- Make the gated setup tickets actionable instead of one-liners.
UPDATE issues
SET required_action = 'On the VPS: docker compose --profile openclaw up -d, then open the OpenClaw QR through the Tailscale tunnel and scan it with the WhatsApp account you want Jarvis to use. No paid WhatsApp Business API is involved.',
    updated_at = now()
WHERE dedupe_key IS NOT NULL
  AND title ILIKE '%WhatsApp%'
  AND status NOT IN ('resolved', 'ignored');

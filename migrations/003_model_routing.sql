-- Model routing: registry drives Supervisor failover instead of hardcoded IDs.
ALTER TABLE model_registry
  ADD COLUMN IF NOT EXISTS route_order integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS auth_profile_id text,
  ADD COLUMN IF NOT EXISTS endpoint_url text,
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

CREATE INDEX IF NOT EXISTS model_registry_roles ON model_registry USING gin (role_assignments);

-- Drop rows pinned to model ids the providers no longer serve; verifyCatalogs reseeds.
DELETE FROM model_registry
WHERE (provider, model_id) IN (
  ('google', 'gemini-2.5-flash'),
  ('nvidia', 'mistralai/mistral-nemotron'),
  ('groq', 'llama-3.3-70b-versatile'),
  ('anthropic', 'claude-3-7-sonnet'),
  ('anthropic', 'claude-3-5-haiku'),
  ('openai_codex', 'gpt-4o')
);

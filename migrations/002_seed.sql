-- Seed only Improvement + Maintenance + bootstrap auth profiles (ADR 012 / 014).
-- The human user row is created by the API bootstrap, not here.

INSERT INTO projects (slug, name, is_system, project_type, confidentiality, default_queue_priority)
VALUES
  ('jarvis-improvement', 'Jarvis Improvement', true, 'system', 'normal', 'background'),
  ('jarvis-maintenance', 'Jarvis Maintenance', true, 'system', 'normal', 'background')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO conversations (project_id, title, channel)
SELECT NULL, 'Supervisor', 'web'
WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE project_id IS NULL AND channel = 'web');

INSERT INTO auth_profiles (id, provider, display_name, owner, billing_owner, auth_type, metered_spend_allowed, health)
VALUES
  ('groq', 'groq', 'Groq', 'Enrique', 'Enrique', 'api_key', false, 'unknown'),
  ('nvidia', 'nvidia', 'NVIDIA NIM / build', 'Enrique', 'Enrique', 'api_key', false, 'unknown'),
  ('google_ai', 'google', 'Google AI', 'Enrique', 'Enrique', 'api_key', false, 'unknown'),
  ('anthropic_personal', 'anthropic', 'Anthropic personal', 'Enrique', 'Enrique', 'subscription_login', false, 'unknown'),
  ('openai_codex_personal', 'openai', 'Codex / ChatGPT personal', 'Enrique', 'Enrique', 'subscription_login', false, 'unknown'),
  ('cursor_personal', 'cursor', 'Cursor personal', 'Enrique', 'Enrique', 'subscription_login', false, 'unknown'),
  ('elevenlabs', 'elevenlabs', 'ElevenLabs', 'Enrique', 'Enrique', 'api_key', false, 'unknown'),
  ('github_personal_admin', 'github', 'GitHub personal admin', 'Enrique', 'Enrique', 'pat', false, 'unknown'),
  ('backup_b2', 'backblaze', 'Backblaze B2 restic', 'Enrique', 'Enrique', 'api_key', false, 'unknown'),
  ('netcup_scp', 'netcup', 'Netcup SCP', 'Enrique', 'Enrique', 'oauth', false, 'unknown')
ON CONFLICT (id) DO NOTHING;

INSERT INTO connections (slug, kind, scope, auth_profile_id)
VALUES
  ('groq', 'groq', 'system', 'groq'),
  ('nvidia', 'nvidia', 'system', 'nvidia'),
  ('google_ai', 'google', 'system', 'google_ai'),
  ('elevenlabs', 'elevenlabs', 'system', 'elevenlabs'),
  ('backup_b2', 'backup', 'system', 'backup_b2'),
  ('netcup_scp', 'http', 'system', 'netcup_scp'),
  ('github_personal_admin', 'github', 'system', 'github_personal_admin')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO schedules (project_id, name, cron, timezone, priority, overlap, model_role, task_template)
SELECT p.id, s.name, s.cron, 'America/New_York', s.priority, 'skip', s.model_role, s.task_template::jsonb
FROM projects p
CROSS JOIN (
  VALUES
    ('weekly-research', '0 10 * * 1', 'background', 'supervisor', '{"lane":"heavy"}'),
    ('health', '*/5 * * * *', 'background', NULL, '{"lane":"system"}'),
    ('daily-retention', '30 3 * * *', 'background', NULL, '{"lane":"system"}'),
    ('weekly-prune', '0 4 * * 0', 'background', NULL, '{"lane":"system"}'),
    ('monthly-restore-test', '0 5 1 * *', 'low', NULL, '{"lane":"system"}')
) AS s(name, cron, priority, model_role, task_template)
WHERE (p.slug = 'jarvis-improvement' AND s.name = 'weekly-research')
   OR (p.slug = 'jarvis-maintenance' AND s.name <> 'weekly-research')
ON CONFLICT (project_id, name) DO NOTHING;

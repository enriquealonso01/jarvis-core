-- Jarvis V1 schema. Raw SQL is the source of truth (ADR 011).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id),
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text,
  ip inet
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  project_type text NOT NULL CHECK (project_type IN ('personal', 'professional', 'system')),
  production_status text NOT NULL DEFAULT 'non_production'
    CHECK (production_status IN ('non_production', 'staging', 'production')),
  customer_facing boolean NOT NULL DEFAULT false,
  confidentiality text NOT NULL DEFAULT 'normal'
    CHECK (confidentiality IN ('normal', 'confidential', 'restricted')),
  github_owner text,
  github_repo text,
  github_repo_id bigint,
  default_branch text,
  deploy_key_credential_id uuid,
  github_api_credential_id uuid,
  default_queue_priority text NOT NULL DEFAULT 'normal'
    CHECK (default_queue_priority IN ('critical', 'high', 'normal', 'low', 'background')),
  metered_spend_allowed boolean NOT NULL DEFAULT false,
  spend_ceiling_cents integer,
  sticky_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE project_instructions_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id),
  version integer NOT NULL,
  body text NOT NULL,
  parsed_policy jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (created_by IN ('user', 'jarvis')),
  UNIQUE (project_id, version)
);

CREATE TABLE dek_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wrapped_key bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE TABLE credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dek_id uuid NOT NULL REFERENCES dek_keys (id),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  fingerprint text,
  kind text NOT NULL,
  broker_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);

ALTER TABLE projects
  ADD CONSTRAINT projects_deploy_key_fk
  FOREIGN KEY (deploy_key_credential_id) REFERENCES credentials (id);
ALTER TABLE projects
  ADD CONSTRAINT projects_github_api_fk
  FOREIGN KEY (github_api_credential_id) REFERENCES credentials (id);

CREATE TABLE auth_profiles (
  id text PRIMARY KEY,
  provider text NOT NULL,
  display_name text NOT NULL,
  owner text,
  billing_owner text,
  auth_type text NOT NULL
    CHECK (auth_type IN ('subscription_login', 'api_key', 'oauth', 'github_app', 'deploy_key', 'pat')),
  confidentiality_eligibility text[] NOT NULL DEFAULT ARRAY['normal']::text[],
  metered_spend_allowed boolean NOT NULL DEFAULT false,
  spend_ceiling_cents integer,
  quota_json jsonb,
  health text NOT NULL DEFAULT 'unknown'
    CHECK (health IN ('unknown', 'healthy', 'degraded', 'expired', 'disabled')),
  expires_at timestamptz,
  credential_id uuid REFERENCES credentials (id),
  harness_auth_dir text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_profile_allowlists (
  auth_profile_id text NOT NULL REFERENCES auth_profiles (id),
  project_id uuid NOT NULL REFERENCES projects (id),
  allowed_roles text[] NOT NULL DEFAULT ARRAY[]::text[],
  PRIMARY KEY (auth_profile_id, project_id)
);

CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  kind text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('system', 'shared', 'project', 'task_ephemeral')),
  auth_profile_id text REFERENCES auth_profiles (id),
  project_id uuid REFERENCES projects (id),
  credential_id uuid REFERENCES credentials (id),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  health text NOT NULL DEFAULT 'unknown',
  last_tested_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scope <> 'project' OR project_id IS NOT NULL)
);

CREATE TABLE connection_project_allowlist (
  connection_id uuid NOT NULL REFERENCES connections (id),
  project_id uuid NOT NULL REFERENCES projects (id),
  PRIMARY KEY (connection_id, project_id)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects (id),
  title text,
  channel text NOT NULL,
  created_from_inbox_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text,
  channel text NOT NULL,
  sender text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  raw_text text,
  raw_payload jsonb,
  artifact_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  checksum text,
  dedupe_key text UNIQUE,
  capture_state text NOT NULL DEFAULT 'received'
    CHECK (capture_state IN ('received', 'persisted', 'failed_capture')),
  processing_state text NOT NULL DEFAULT 'pending'
    CHECK (processing_state IN ('pending', 'classified', 'routed', 'processed', 'ignored', 'failed')),
  project_id uuid REFERENCES projects (id),
  conversation_id uuid REFERENCES conversations (id),
  supervisor_payload_mode text NOT NULL DEFAULT 'full'
    CHECK (supervisor_payload_mode IN ('full', 'metadata_only')),
  routing_note text
);

CREATE UNIQUE INDEX inbox_events_channel_external_id
  ON inbox_events (channel, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX inbox_events_processing_received
  ON inbox_events (processing_state, received_at);
CREATE INDEX inbox_events_project_received
  ON inbox_events (project_id, received_at);

ALTER TABLE conversations
  ADD CONSTRAINT conversations_inbox_fk
  FOREIGN KEY (created_from_inbox_id) REFERENCES inbox_events (id);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations (id),
  inbox_event_id uuid REFERENCES inbox_events (id),
  role text NOT NULL CHECK (role IN ('user', 'jarvis', 'system')),
  body text NOT NULL,
  artifact_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects (id),
  conversation_id uuid REFERENCES conversations (id),
  origin_inbox_id uuid REFERENCES inbox_events (id),
  title text NOT NULL,
  objective text,
  state text NOT NULL
    CHECK (state IN (
      'captured', 'classified', 'queued', 'preparing', 'running',
      'waiting_for_tool', 'waiting_for_provider', 'waiting_for_user',
      'waiting_for_approval', 'paused', 'stalled', 'recovering',
      'retry_scheduled', 'succeeded', 'failed_terminal', 'cancelled'
    )),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('critical', 'high', 'normal', 'low', 'background')),
  lane text NOT NULL CHECK (lane IN ('supervisor', 'heavy', 'system')),
  model_role text,
  auth_profile_id text REFERENCES auth_profiles (id),
  harness text,
  worktree_path text,
  branch text,
  head_sha text,
  external_session_id text,
  lease_owner text,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  waiting_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tasks_active_lease
  ON tasks (state, lease_until)
  WHERE state IN ('queued', 'running', 'recovering');
CREATE INDEX tasks_priority_created ON tasks (priority, created_at);

CREATE TABLE task_dependencies (
  task_id uuid NOT NULL REFERENCES tasks (id),
  predecessor_id uuid NOT NULL REFERENCES tasks (id),
  PRIMARY KEY (task_id, predecessor_id)
);

CREATE TABLE task_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks (id),
  from_state text,
  to_state text NOT NULL,
  cause text,
  actor text,
  inbox_event_id uuid REFERENCES inbox_events (id),
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks (id),
  n integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  error_class text,
  summary text,
  UNIQUE (task_id, n)
);

CREATE TABLE task_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks (id),
  at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);

CREATE TABLE task_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks (id),
  project_id uuid NOT NULL REFERENCES projects (id),
  actions text[] NOT NULL,
  repo text,
  environment text,
  allowed_sha text,
  expires_at timestamptz,
  invalidated_at timestamptz,
  invalidate_reason text,
  source_inbox_id uuid REFERENCES inbox_events (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_action_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid,
  kind text NOT NULL,
  token_hash bytea,
  expires_at timestamptz,
  consumed_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  category text NOT NULL,
  project_id uuid REFERENCES projects (id),
  task_id uuid REFERENCES tasks (id),
  service text,
  status text NOT NULL
    CHECK (status IN (
      'open', 'investigating', 'auto_resolving', 'resolved',
      'waiting_for_jarvis', 'waiting_for_user', 'waiting_for_provider', 'ignored'
    )),
  owner text NOT NULL CHECK (owner IN ('jarvis', 'user', 'provider')),
  title text NOT NULL,
  evidence jsonb,
  required_action text,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  suppress_reason text
);

CREATE UNIQUE INDEX issues_open_dedupe
  ON issues (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status NOT IN ('resolved', 'ignored');

CREATE TABLE issue_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues (id),
  at timestamptz NOT NULL DEFAULT now(),
  body text NOT NULL,
  actor text
);

ALTER TABLE user_action_requests
  ADD CONSTRAINT user_action_requests_issue_fk
  FOREIGN KEY (issue_id) REFERENCES issues (id);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type text NOT NULL,
  project_id uuid REFERENCES projects (id),
  target text,
  environment text,
  resource_version text,
  task_id uuid REFERENCES tasks (id),
  state text NOT NULL
    CHECK (state IN ('pending', 'approved', 'rejected', 'expired', 'consumed', 'invalidated')),
  user_action_request_id uuid REFERENCES user_action_requests (id),
  expires_at timestamptz,
  decided_at timestamptz
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects (id),
  path text NOT NULL,
  sha256 text,
  mime text,
  bytes bigint,
  source text,
  quarantine_state text NOT NULL DEFAULT 'pending'
    CHECK (quarantine_state IN ('pending', 'clean', 'blocked')),
  retention_class text NOT NULL DEFAULT 'other'
    CHECK (retention_class IN ('raw_audio', 'transcript', 'knowledge', 'build', 'other')),
  retain_until timestamptz,
  permanent boolean NOT NULL DEFAULT false,
  inbox_event_id uuid REFERENCES inbox_events (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id),
  name text NOT NULL,
  task_template jsonb NOT NULL DEFAULT '{}'::jsonb,
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/New_York',
  priority text NOT NULL DEFAULT 'background'
    CHECK (priority IN ('critical', 'high', 'normal', 'low', 'background')),
  allowed_connection_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  model_role text,
  approval_policy jsonb,
  overlap text NOT NULL DEFAULT 'skip'
    CHECK (overlap IN ('queue', 'skip', 'replace', 'parallel')),
  misfire text,
  max_catchup integer,
  failure_threshold integer,
  openclaw_automation_id text,
  paused boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE schedule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES schedules (id),
  inbox_event_id uuid REFERENCES inbox_events (id),
  task_id uuid REFERENCES tasks (id),
  scheduled_for timestamptz,
  started_at timestamptz,
  result text
);

CREATE TABLE notifications_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'ui', 'phone')),
  message_type text,
  body text NOT NULL,
  object_type text,
  object_id uuid,
  idempotency_key text UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sent', 'failed')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  project_id uuid REFERENCES projects (id),
  target text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE health_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service text NOT NULL,
  severity text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  summary text,
  issue_id uuid REFERENCES issues (id)
);

CREATE TABLE model_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model_id text NOT NULL,
  pinned_version text,
  capabilities jsonb,
  context_size integer,
  cost_type text,
  privacy_eligibility text,
  health text NOT NULL DEFAULT 'unknown',
  quota_json jsonb,
  approval_state text NOT NULL DEFAULT 'discovered'
    CHECK (approval_state IN ('discovered', 'approved', 'disabled')),
  deprecation_at timestamptz,
  role_assignments text[] NOT NULL DEFAULT ARRAY[]::text[],
  UNIQUE (provider, model_id)
);

CREATE TABLE benchmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_registry_id uuid NOT NULL REFERENCES model_registry (id),
  harness text,
  suite text,
  scores jsonb,
  ran_at timestamptz NOT NULL DEFAULT now(),
  artifact_id uuid REFERENCES artifacts (id)
);

CREATE TABLE config_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('global', 'project')),
  project_id uuid REFERENCES projects (id),
  key text NOT NULL,
  value jsonb NOT NULL,
  version integer NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  actor text,
  note text
);

CREATE TABLE channel_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL,
  identifier text NOT NULL,
  display text,
  can_command boolean NOT NULL DEFAULT false,
  project_id uuid REFERENCES projects (id),
  UNIQUE (channel, identifier)
);

CREATE TABLE routing_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_event_id uuid NOT NULL REFERENCES inbox_events (id),
  from_project uuid REFERENCES projects (id),
  to_project uuid REFERENCES projects (id),
  at timestamptz NOT NULL DEFAULT now(),
  actor text
);

CREATE TABLE onboarding_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations (id),
  status text NOT NULL CHECK (status IN ('in_progress', 'finalized', 'cancelled')),
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  project_id uuid REFERENCES projects (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects (id),
  kind text NOT NULL,
  body text NOT NULL,
  source_inbox_id uuid REFERENCES inbox_events (id),
  artifact_id uuid REFERENCES artifacts (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects (id),
  body text NOT NULL,
  source_artifact_id uuid REFERENCES artifacts (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

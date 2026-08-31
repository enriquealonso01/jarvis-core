# Jarvis V1 data model

PostgreSQL 16. `uuid` primary keys (`gen_random_uuid()`). Timestamps `timestamptz`. Application is the only writer.

Enums are listed as text + check constraints (easier migrations than PG enums for V1).

---

## users

| column | type | notes |
|---|---|---|
| id | uuid pk | single row in V1 |
| email | citext unique | |
| password_hash | text | argon2id |
| created_at | timestamptz | |

## sessions

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid fk | |
| token_hash | bytea unique | sha256 of token |
| created_at | timestamptz | |
| last_seen_at | timestamptz | |
| expires_at | timestamptz | |
| user_agent | text | |
| ip | inet | |

## projects

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| slug | text unique | |
| name | text | |
| is_system | bool | |
| project_type | text | personal / professional / system |
| production_status | text | non_production / staging / production |
| customer_facing | bool | |
| confidentiality | text | normal / confidential / restricted |
| github_owner | text | |
| github_repo | text | |
| github_repo_id | bigint | |
| default_branch | text | |
| deploy_key_credential_id | uuid | |
| github_api_credential_id | uuid | |
| default_queue_priority | text | |
| metered_spend_allowed | bool | default false |
| spend_ceiling_cents | int | null |
| sticky_until | timestamptz | UI active project |
| created_at | timestamptz | |
| archived_at | timestamptz | |

## project_instructions_versions

Versioned AGENTS.md / policy JSON. `config_versions` may point here.

| column | type |
|---|---|
| id | uuid pk |
| project_id | uuid |
| version | int |
| body | text |
| parsed_policy | jsonb |
| created_at | timestamptz |
| created_by | text | user / jarvis |

## auth_profiles

| column | type | notes |
|---|---|---|
| id | text pk | e.g. `anthropic_personal` |
| provider | text | |
| display_name | text | |
| owner | text | human-readable |
| billing_owner | text | |
| auth_type | text | subscription_login / api_key / oauth / github_app / deploy_key / pat |
| confidentiality_eligibility | text[] | |
| metered_spend_allowed | bool | |
| spend_ceiling_cents | int | |
| quota_json | jsonb | |
| health | text | unknown / healthy / degraded / expired / disabled |
| expires_at | timestamptz | |
| credential_id | uuid | ciphertext row; null if host-dir only (harness) |
| harness_auth_dir | text | path if ADR 006 |
| created_at | timestamptz | |

## auth_profile_allowlists

| column | type |
|---|---|
| auth_profile_id | text |
| project_id | uuid |
| allowed_roles | text[] | supervisor / task / reviewer / utility / stt / tts / embeddings |

Unique (auth_profile_id, project_id).

## connections

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| slug | text | |
| kind | text | github / netlify / composio / mcp / telnyx / elevenlabs / groq / nvidia / google / backup / slack / http / other |
| scope | text | system / shared / project / task_ephemeral |
| auth_profile_id | text | nullable |
| project_id | uuid | required if scope=project |
| credential_id | uuid | |
| config | jsonb | site ids, repo allowlist, mcp command |
| health | text | |
| last_tested_at | timestamptz | |
| expires_at | timestamptz | ephemeral |
| created_at | timestamptz | |

## connection_project_allowlist

For scope=shared: which projects. System connections are not in this table; they use capabilities + role checks.

## credentials

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| dek_id | uuid | |
| ciphertext | bytea | |
| nonce | bytea | |
| fingerprint | text | last4 / ssh sig / hash prefix |
| kind | text | |
| broker_only | bool | never mount |
| created_at | timestamptz | |
| rotated_at | timestamptz | |

No plaintext column.

## dek_keys

| column | type |
|---|---|
| id | uuid |
| wrapped_key | bytea | wrapped with master |
| created_at | timestamptz |
| retired_at | timestamptz |

## inbox_events

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| external_id | text | unique where not null |
| channel | text | whatsapp / phone / web / upload / schedule / webhook / system / connection_callback |
| sender | text | |
| occurred_at | timestamptz | |
| received_at | timestamptz | |
| raw_text | text | |
| raw_payload | jsonb | redacted copies only in logs |
| artifact_ids | uuid[] | |
| checksum | text | sha256 |
| dedupe_key | text unique | |
| capture_state | text | received / persisted / failed_capture |
| processing_state | text | pending / classified / routed / processed / ignored / failed |
| project_id | uuid | nullable until routed; null = global Supervisor |
| conversation_id | uuid | |
| supervisor_payload_mode | text | full / metadata_only |
| routing_note | text | |

Indexes: (processing_state, received_at), (project_id, received_at), unique(channel, external_id).

## conversations

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid | **nullable** — null means global Supervisor conversation |
| title | text | |
| channel | text | |
| created_from_inbox_id | uuid | |
| created_at | timestamptz | |
| last_activity_at | timestamptz | |

## messages

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| conversation_id | uuid | |
| inbox_event_id | uuid | |
| role | text | user / jarvis / system |
| body | text | |
| artifact_ids | uuid[] | |
| created_at | timestamptz | |

## tasks

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid | nullable for global Supervisor / create-project work |
| conversation_id | uuid | |
| origin_inbox_id | uuid | |
| title | text | |
| objective | text | |
| state | text | STATE_MACHINES |
| priority | text | critical / high / normal / low / background |
| lane | text | supervisor / heavy / system |
| model_role | text | |
| auth_profile_id | text | |
| harness | text | |
| worktree_path | text | |
| branch | text | |
| head_sha | text | |
| external_session_id | text | OpenClaw/ACP |
| lease_owner | text | worker id |
| lease_until | timestamptz | |
| heartbeat_at | timestamptz | |
| cancel_requested_at | timestamptz | |
| waiting_reason | text | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

Indexes: partial where state in queued/running/recovering; (priority, created_at).

## task_dependencies

task_id, predecessor_id, unique pair.

## task_transitions

id, task_id, from_state, to_state, cause, actor, inbox_event_id, at.

## task_attempts

id, task_id, n, started_at, ended_at, error_class, summary.

## task_checkpoints

id, task_id, at, payload jsonb (plan §25 fields).

## task_grants

| column | type |
|---|---|
| id | uuid |
| task_id | uuid |
| project_id | uuid |
| actions | text[] | merge, deploy, ... |
| repo | text |
| environment | text |
| allowed_sha | text | set after validation |
| expires_at | timestamptz |
| invalidated_at | timestamptz |
| invalidate_reason | text |
| source_inbox_id | uuid |
| created_at | timestamptz |

## approvals

| column | type |
|---|---|
| id | uuid |
| action_type | text |
| project_id | uuid |
| target | text |
| environment | text |
| resource_version | text |
| task_id | uuid |
| state | text | pending / approved / rejected / expired / consumed / invalidated |
| user_action_request_id | uuid |
| expires_at | timestamptz |
| decided_at | timestamptz |

## issues

| column | type |
|---|---|
| id | uuid |
| severity | text | critical / high / medium / low |
| category | text | error class prefix |
| project_id | uuid | |
| task_id | uuid | |
| service | text | |
| status | text | STATE_MACHINES |
| owner | text | jarvis / user / provider |
| title | text | |
| evidence | jsonb | |
| required_action | text | |
| dedupe_key | text | unique among open-ish |
| created_at | timestamptz | |
| updated_at | timestamptz | |
| resolved_at | timestamptz | |
| suppress_reason | text | |

## issue_events

id, issue_id, at, body, actor.

## user_action_requests

| column | type |
|---|---|
| id | uuid |
| issue_id | uuid |
| kind | text | api_key / oauth / composio / mcp / browser_login / confirm / secret |
| token_hash | bytea | |
| expires_at | timestamptz | |
| consumed_at | timestamptz | |
| payload | jsonb | scopes, provider, cost/privacy copy |
| created_at | timestamptz | |

## artifacts

| column | type |
|---|---|
| id | uuid |
| project_id | uuid |
| path | text | relative to artifacts root |
| sha256 | text |
| mime | text |
| bytes | bigint |
| source | text |
| quarantine_state | text | pending / clean / blocked |
| retention_class | text | raw_audio / transcript / knowledge / build / other |
| retain_until | timestamptz |
| permanent | bool |
| inbox_event_id | uuid |
| created_at | timestamptz |

## schedules

| column | type |
|---|---|
| id | uuid |
| project_id | uuid |
| name | text |
| task_template | jsonb |
| cron | text |
| timezone | text | default America/New_York |
| priority | text |
| allowed_connection_ids | uuid[] |
| model_role | text |
| approval_policy | jsonb |
| overlap | text | queue / skip / replace / parallel |
| misfire | text |
| max_catchup | int |
| failure_threshold | int |
| openclaw_automation_id | text |
| paused | bool |
| created_at | timestamptz |

## schedule_runs

id, schedule_id, inbox_event_id, task_id, scheduled_for, started_at, result.

## notifications_outbox

| column | type |
|---|---|
| id | uuid |
| channel | text | whatsapp / ui / phone |
| message_type | text | silent skipped rows never inserted |
| body | text |
| object_type | text |
| object_id | uuid |
| idempotency_key | text unique |
| attempts | int |
| next_attempt_at | timestamptz |
| state | text | pending / sent / failed |
| last_error | text |
| created_at | timestamptz |

## audit_events

Append-only. id, at, actor, action, project_id, target, metadata jsonb (redacted). No updates/deletes from the app.

## health_incidents

id, service, severity, opened_at, closed_at, summary, issue_id.

## model_registry

id, provider, model_id, pinned_version, capabilities jsonb, context_size, cost_type, privacy_eligibility, health, quota_json, approval_state, deprecation_at, role_assignments text[].

## benchmarks

id, model_registry_id, harness, suite, scores jsonb, ran_at, artifact_id.

## config_versions

id, scope (global/project), project_id, key, value jsonb, version, at, actor, note.

## channel_allowlist

id, channel, identifier (E.164), display, can_command bool, project_id nullable (bind sender to project).

## routing_overrides

id, inbox_event_id, from_project, to_project, at, actor.

## onboarding_sessions

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| conversation_id | uuid | |
| status | text | in_progress / finalized / cancelled |
| answers | jsonb | TEMPLATES fields |
| project_id | uuid | set on finalize |
| created_at | timestamptz | |
| updated_at | timestamptz | |

## memory_items

Durable notes. `project_id` **nullable** (null = global Supervisor memory, first-run pasted docs). id, project_id, kind, body, source_inbox_id, artifact_id, created_at. Embeddings optional later (ADR 007). Launch = keyword search.

## knowledge_chunks

Optional later; same as memory with source artifact. Accounted: table exists, worker may be Phase 6.

---

## Seed rows (Phase 1)

- one user (bootstrap CLI)
- projects: **jarvis-improvement**, **jarvis-maintenance** only (ADR 012)
- one global Supervisor conversation (project_id null or a synthetic `global` flag — prefer `conversations.project_id` nullable)
- auth_profiles rows for boot §8.5 **plus** groq, nvidia, google_ai, elevenlabs, backup_b2 (credentials filled at Netcup bootstrap, ADR 014)
- default schedules: Improvement weekly, Maintenance health/retention
- no application or professional project rows

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

---

# Tables added after the first draft

The schema grew from 37 tables to 57 while this file described 37 of them. These
are the twenty that arrived since, documented from the migrations that created
them and the code that writes them. One paragraph each: what it holds, and who
writes it — the second half is the one that is hard to recover later.

## task_events

The timeline of a heavy run: one row per phase entered, tool call made, review
finding, or error. Written by the runner as a run proceeds, and read by the Work
detail, by `collectEvidence` when a benchmark scores a run, and by the console
to answer "what is it doing right now".

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| task_id | uuid | |
| at | timestamptz | |
| type | text | phase / tool / review / error |
| name | text | the phase name, tool name, or error class |
| summary | text | one line, capped at 500 characters |
| artifact_id | uuid | when the event produced a file |

`type = 'error'` arrived in migration 037: both runtimes report a failed tool and
the runner dropped them, so a clean run and one that failed half its commands
were indistinguishable.

## task_context

Mid-run context: something Enrique said after a task started, waiting to be
handed to the agent at its next checkpoint boundary. Written by the router when
a message lands on a running task; cleared by the runner when it delivers.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| task_id | uuid | |
| inbox_event_id | uuid | where it came from |
| conversation_id | uuid | |
| body | text | |
| created_at | timestamptz | |
| delivered_at | timestamptz | null until the agent has seen it |
| delivered_attempt | integer | which attempt received it |
| attached_state | text | the task state when it was attached |

Pulled rather than pushed: a process mid-model-call has nowhere to receive a
signal, so the runner reads this at its own checkpoint.

## activity_events

The human-readable feed: the handful of moments a person would want to read,
rather than every state change. Written by `transitionTask` for the states worth
mentioning, and by anything else that wants a line on the timeline.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid | nullable for system-wide events |
| at | timestamptz | |
| kind | text | |
| subject_id | uuid | the task, issue or conversation |
| title | text | |
| detail | text | |
| actor | text | who caused it |
| href | text | where to go to see it |

Deliberately not a log of the state machine — `task_transitions` already is that,
and nobody scrolls it.

## active_project

Which project the console is currently pointed at. One row. Written by the
console when the operator switches project, read by anything that needs a
default.

| column | type |
|---|---|
| id | uuid pk |
| project_id | uuid |
| set_by | text |
| set_at | timestamptz |

## sender_project_binding

Which project a given sender on a given channel is talking about, so a WhatsApp
message does not need to name its project every time. Written during onboarding
and by explicit rebinding; read by the router.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| channel | text | whatsapp / sms / console |
| sender | text | the E.164 number or console user |
| project_id | uuid | |
| enabled | boolean | a binding is disabled rather than deleted |
| created_at | timestamptz | |

## calls

One row per phone call, inbound or outbound, keyed by the Telnyx call control
id. Holds the live state of the call state machine, the deadline the worker
sweeps against, and the artifacts produced. Written by the call runtime on every
webhook.

| column | type | notes |
|---|---|---|
| call_control_id | text pk | Telnyx |
| call_leg_id | text | |
| from_e164 | text | |
| conversation_id | uuid | |
| state | text | ringing / greeting / listening / thinking / speaking / closing |
| deadline_at | timestamptz | swept from the worker, so a deadline survives an API restart |
| deadline_leg | text | which leg the deadline belongs to |
| turns | integer | |
| silence_prompts | integer | |
| transcript_artifact_id | uuid | |
| started_at, state_at, ended_at | timestamptz | |
| end_reason | text | |
| pending_text, pending_since | text, timestamptz | speech heard but not yet answered |
| speaking_marker | text | the marker Telnyx echoes when playback finishes |
| barge_ins | integer | |
| summary | text | |
| recording_artifact_id | uuid | |

Persisted rather than held in a module-level map, because a restart mid-call
would otherwise erase the call.

## call_turns

One row per exchange within a call: what was heard, what was answered, and where
the time went. Written by the call runtime; read by the latency work and by S24
call review.

| column | type | notes |
|---|---|---|
| id | bigint pk | |
| call_control_id | text | |
| n | integer | turn number within the call |
| heard | text | |
| started_at | timestamptz | |
| ack_ms, model_ms, tts_ms, total_ms | integer | the latency breakdown |
| tool_started_at, tool_ended_at | timestamptz | |
| answer_text | text | |
| answered_at | timestamptz | |
| handover_task_id | uuid | when the turn created work |
| inbox_event_id | uuid | |
| outcome | text | |
| ack_text | text | the immediate acknowledgement, before the real answer |
| answered_by | text | tier1 / desk — added in migration 035 |

## call_speech

The raw utterances of a call, both directions, in order. Written by the call
runtime as transcription and playback happen; the transcript artifact is built
from these.

| column | type | notes |
|---|---|---|
| id | bigint pk | |
| call_control_id | text | |
| turn_id | bigint | null for speech outside a turn |
| kind | text | heard / said |
| text | text | |
| at | timestamptz | |

## call_transitions

The call state machine, one row per hop, mirroring `task_transitions`. Written
by the call runtime whenever the state changes.

| column | type | notes |
|---|---|---|
| id | bigint pk | |
| call_control_id | text | |
| at | timestamptz | |
| from_state, to_state | text | |
| cause | text | |
| event_type | text | the Telnyx webhook that caused it |

## outbound_calls

The queue of reasons Jarvis wants to ring Enrique, and what happened to each.
Written by the reasons sweep in the worker; read by `placeCall`.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| reason | text | one of the six sanctioned reasons |
| subject | text | |
| issue_id, task_id, project_id, schedule_id | uuid | whichever applies |
| state | text | wanted / placing / placed / done / blocked |
| blocked_reason | text | quiet hours, no number, provider refusal |
| retry_after | timestamptz | |
| call_control_id | text | once placed |
| wanted_at, placed_at, ended_at | timestamptz | |
| attempts | integer | `placeCall` refuses a row with attempts above zero |

## escalations

Every time a task moved up a pool rather than sideways, keyed by task shape so a
shape that always escalates is visible without reading a log. Written by
recovery rung 8; read by the benchmark.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| task_id | uuid | |
| shape | text | what kind of task this was |
| from_profile, to_profile | text | |
| cause | text | |
| at | timestamptz | |

## model_policy

A single row holding the standing rules: whether only
open-weights models may be used, the monthly ceiling, the autonomy level, and
the soft ceiling with the month it was last warned about. Written by the console
and by configuration-by-conversation.

| column | type | notes |
|---|---|---|
| id | boolean pk | always true — one row, enforced by the type |
| open_weights_only | boolean | |
| monthly_ceiling_usd | numeric | |
| autonomy | text | |
| updated_at | timestamptz | |
| soft_ceiling_usd | numeric | |
| soft_notified_month | date | so one warning is sent per month, not per call |

## model_usage

One row per model call: who was asked, in what role, for which
task or conversation, and what it cost. Written by the supervisor and the
runtime wrapper; read by the spend ceiling and the daily digest.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| at | timestamptz | |
| provider, model_id | text | |
| role | text | supervisor / task / reviewer / utility / stt / tts / embeddings |
| conversation_id, task_id | uuid | |
| input_tokens, output_tokens, cached_tokens | integer | |
| cost_usd | numeric | null for a subscription, which is not metered |
| transport | text | how the call was made |

## quota_observations

What a subscription said about itself, when it said it. Written whenever a
provider reports a limit or a reset, and by the estimator when it has to guess.
Read by routing, which treats quota as an input rather than a reason to stop
(ADR 017).

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| at | timestamptz | |
| auth_profile_id | text | |
| kind | text | what sort of observation |
| status | text | |
| remaining_pct | numeric | |
| estimated | boolean | true when this is inference, not a provider statement |
| resets_at | timestamptz | |
| detail | text | |
| task_id | uuid | the run that produced the observation |

`estimated` matters: an inferred remaining percentage and a reported one must
never be read as the same fact.

## oauth_device_flows

An in-flight device-code login: the code to show, where to enter it, and how
often to poll. Written when a login starts, updated by polling, and deleted or
marked terminal when it resolves.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| auth_profile_id | text | |
| device_code, user_code | text | |
| verification_uri, verification_uri_complete | text | |
| interval_seconds | integer | provider-specified poll interval |
| started_at, expires_at, last_polled_at | timestamptz | |
| state | text | pending / approved / denied / expired |
| detail | text | |

## reauth_events

When a session was re-authenticated. Written by the API on a successful step-up;
read by anything that needs to know how recently the operator proved who they
are.

| column | type |
|---|---|
| id | uuid pk |
| session_id | text |
| at | timestamptz |

## internal_requests

Idempotency for internal HMAC-signed posts: the request id, the route, and the
response that was returned the first time. Written by the internal-request
guard; a replay returns the stored response rather than acting twice.

| column | type | notes |
|---|---|---|
| request_id | text pk | |
| route | text | |
| at | timestamptz | |
| response | jsonb | replayed verbatim |

## resource_metrics

Host CPU, memory, disk and load, sampled every five minutes. Written by the
worker; read by the resource classes in the taxonomy and by System Health.

| column | type |
|---|---|
| id | bigint pk |
| at | timestamptz |
| cpu_busy_pct | numeric |
| memory_used_pct | numeric |
| disk_used_pct | numeric |
| disk_free_bytes | bigint |
| load1 | numeric |

## component_sweeps

One row per component that sweeps, recording the last COMPLETED sweep rather
than a tick. Written by the worker after its watchdog sweep returns; read by the
API and by a host timer outside the container, because a component must not be
the sole author of its own liveness.

| column | type | notes |
|---|---|---|
| component | text pk | |
| last_completed_at | timestamptz | written after the sweep, never before |
| sweeps | bigint | monotonic, so a component that finished once and stopped is visible |
| owner | text | which process, so a change of hand shows |
| updated_at | timestamptz | |

## schema_migrations

Which migration files have been applied. Written by the migration runner inside
the same transaction that applies the file, so a half-applied migration is not
recorded as done.

| column | type |
|---|---|
| filename | text pk |
| applied_at | timestamptz |

## connection_tools

The tools one connection offers, and what has been decided about each. S31's
rule is that a classification is pinned to the tool's MANIFEST rather than to a
version string the provider controls: `manifest_hash` is taken over name,
description and schema, and a tool is callable only while `classified_hash`
still equals it. A provider that silently rewrites a tool's description
therefore loses its classification rather than keeping it.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| connection_id | uuid | which connection offers it |
| name | text | as the server reports it |
| description | text | untrusted text, held as data and never interpolated |
| input_schema | jsonb | |
| manifest_hash | text | sha256 over name + description + schema |
| level | integer | null until classified; null means not callable |
| classified_hash | text | the manifest that was classified; drift disables the tool |
| classified_at | timestamptz | |
| classified_by | text | |
| capability | text | required; classification refuses a tool that claims none |
| first_seen_at | timestamptz | |

## browser_actions

Every interaction the browser was asked to perform, and what was decided about
it. Written for allowed and refused actions alike — a gate that records only
refusals cannot answer "what did it actually do on my behalf", which is the
question that matters after the fact.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid | |
| task_id | uuid | |
| at | timestamptz | |
| url | text | |
| kind | text | navigate, type, click, submit … |
| element | text | |
| label | text | the visible label, which is what a person would have read |
| method | text | GET/POST where known; a POST is not a navigation |
| destination | text | |
| decision | text | allow / confirm / refuse |
| reason | text | in words, for the person reading it later |
| rule | text | which rule decided, so the decision is traceable to a line |
| approval_id | uuid | set when a person confirmed it |
| before_artifact_id | uuid | screenshot before |
| after_artifact_id | uuid | screenshot after |

## browser_sessions

One row per site a project has a live browser session with. Expiry is decided at
USE rather than by a sweep: a session marked live by a timer that has not run
yet is a session that fails in the middle of a task instead of at the start.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid | sessions never cross a project, which is why this is not null |
| connection_slug | text | |
| domain | text | |
| established_at | timestamptz | |
| expires_at | timestamptz | null means no declared expiry, not "never expires" |
| last_ok_at | timestamptz | |
| state | text | live / failed; default live |
| state_reason | text | |

## unprompted_messages

Messages Jarvis wants to start a conversation with, before anyone asked it
anything. `reason` is drawn from a CLOSED list — the point of S33 is that the
set of reasons to interrupt him is enumerated in code rather than judged per
message — and `send_after` carries quiet hours, so a message wanted at 02:00 is
queued rather than suppressed.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| reason | text | one of the closed set; an unknown reason is refused, not sent |
| subject | text | |
| link | text | delivered here rather than spoken, per S39 |
| project_id | uuid | |
| wanted_at | timestamptz | when it became worth saying |
| send_after | timestamptz | when it may be said |
| sent_at | timestamptz | |
| batch_id | uuid | several things worth saying at once arrive as one message |
| refused_reason | text | why it was never sent, kept rather than dropped |

## improvement_candidates

What the weekly Improvement scan proposed, and what was decided. A decline is
pinned to `declined_fingerprint` — a hash of the PROPOSAL, not of prose — so a
candidate returns on its own when what it proposes actually changes, and stays
declined when only its wording does. Nothing here activates itself; `approve`
creates a queued task and that task is what does the work.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| candidate_key | text unique | stable identity across scans: what it is about |
| title | text | |
| pitch | text | |
| fingerprint | text | sha256 over the proposal; two scans of an unchanged system agree |
| status | text | proposed / declined / approved |
| declined_fingerprint | text | what was declined; a changed proposal is not it |
| declined_at | timestamptz | |
| approved_task_id | uuid | the real task; approval creates work, it does not do work |
| approved_at | timestamptz | |
| first_seen_at | timestamptz | |
| last_seen_at | timestamptz | |
| times_seen | integer | |

## briefs

What Jarvis said it was about to do before doing it, and the plan it is doing.
`plan` is the USER-FACING plan — intent, handoffs, completion channel — and it
is the object execution reads, which is what lets a reply of "send it to the
console instead" change where things actually go. Recorded beside the plan
instead, a redirection would update the record of the conversation while the
work carried on to WhatsApp. The step decomposition is deliberately absent, so
nothing downstream can report internal steps back to him.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| conversation_id | uuid | nullable: losing the brief is worse than losing the link |
| project_id | uuid | |
| intent | text | the outcome he asked for, in one clause |
| plan | jsonb | the user-facing plan; execution reads THIS |
| brief_text | text | verbatim, never re-rendered — a redirect must not rewrite what he was told |
| sent_at | timestamptz | |
| redirected_at | timestamptz | null means he ignored it, which is a legitimate answer |

## issue_candidates

The count that has to exist before an Issue does. B10 gives `resource.cpu` the
position "ui_only (Issue if sustained)", and an Issue carries its own occurrence
count — which only helps once one exists, and whether to create one is precisely
the decision being made. So the run-up is counted here, beside the Issue list
rather than on it: a suppressed row in `issues` would have been less code and
would have put the thing on the list it is being kept off.

Rows are deleted on promotion, so a recurrence after the Issue is resolved starts
a fresh episode rather than arriving already at the threshold.

| column | type | notes |
|---|---|---|
| dedupe_key | text pk | the key the Issue would dedupe by, so promotion is a lookup |
| category | text | |
| occurrences | integer | this episode only |
| first_seen_at | timestamptz | when this episode began, not the category's first ever sighting |
| last_seen_at | timestamptz | a gap wider than SUSTAINED_WINDOW_MS restarts the count |

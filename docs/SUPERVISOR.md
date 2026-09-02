# Supervisor

> Written for Slice A, when the Supervisor could only edit Jarvis's own records.
> Updated once `task_create` shipped, because that tool is what the whole plan
> turns on and this document declared a catalog without it **exhaustive**.

The Supervisor is a Jarvis API loop, not an OpenClaw agent completion.

## When it runs

After an Inbox Event is `persisted` and routed to the global conversation or a project conversation, on the Supervisor lane. Never before persist.

## Preconditions

`GET /api/health` reports a healthy Supervisor route (plan §35 / INITIAL_MODEL_ROUTING). If missing, the Control Center composer is disabled. Bootstrap collects every provider in the current routing table (v2 plan VI.0 — the hosted open-weights primary and its fallback, the subscription logins, STT, TTS; the original free-tier list is superseded). A missing Supervisor route is an Issue, not an invitation to skip setup.

## Prompt inputs

- Global or project instructions (config_versions)
- Recent messages in that conversation (bounded)
- Matching `memory_items` (global if `project_id` is null; plus project items if scoped)
- Tool catalog below
- Never a project-owned profile that is not allowlisted for Supervisor
- Confidential project bodies: ADR 005 `metadata_only`

## Tool catalog

The model cannot exec, read host files, or call the broker's GitHub admin.

**This table is generated from `TOOLS` in `src/supervisor.ts` and must match it.**
Adding a Supervisor tool without adding its row here leaves the only human-readable
description of what Jarvis can do quietly wrong — which is how this document came
to omit the most important tool in the system for a day.

| tool | does |
|---|---|
| **`task_create`** | **Create work.** Project, objective, lane, priority, and the conversation and inbox event that caused it. Heavy work goes to `lane='heavy'`, where the runner picks it up. This is the tool that makes Jarvis act rather than answer |
| `memory_upsert` | Store or update a note. `project_id` optional (null = global) |
| `memory_search` | Keyword search memory |
| `project_list` | Name, type, confidentiality |
| `project_onboarding_start` | Create `onboarding_sessions` (status=in_progress) |
| `project_onboarding_set` | Set one answered field from TEMPLATES |
| `project_onboarding_finalize` | Insert `projects` row when required fields present. GitHub may be null |
| `conversation_create` | Open a new thread |
| `connection_list` | What this project may use |
| `connection_request` | Open a UserActionRequest for a missing key |
| `issue_create` | When the Supervisor is blocked |
| `models_list` | Read the registry rather than answering from what the model believes about its own family |

**Still not Supervisor tools:** `github.*`, harness spawn, anything that executes.
Those belong to the heavy lane and the broker. The Supervisor decides *that* work
should happen and creates the task; it never does the work itself.

That distinction is the reason `task_create` is safe to hand it: creating a task
commits nothing. Every gate — isolation, grants, always-confirm — is enforced
where the task runs, not where it was requested.

## Onboarding fields (TEMPLATES)

Required to finalize: `name`, `slug`, `project_type` (personal\|professional).

Required if professional: confidentiality, production_status, customer_facing, metered_spend_allowed (default false), which existing auth profiles may be used (default: none until listed; personal profiles may be offered as checkboxes).

Optional until later: GitHub owner/repo, deploy policy. Finalize is allowed with `github_repo` null; engineering tasks then wait on Issue “connect repository.”

## Turn persistence

User message → Inbox Event → `messages` row. Assistant message → `messages` row. Each tool call → `task` only if it starts durable work; memory upsert is not a heavy task.

SSE: `conversation.message` after each assistant message.

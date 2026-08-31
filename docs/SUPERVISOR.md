# Supervisor (Slice A)

The Supervisor is a Jarvis API loop, not an OpenClaw agent completion.

## When it runs

After an Inbox Event is `persisted` and routed to the global conversation or a project conversation, on the Supervisor lane. Never before persist.

## Preconditions

`GET /api/health` reports a healthy Supervisor route (plan §35 / INITIAL_MODEL_ROUTING). If missing, the Control Center composer is disabled. Bootstrap is supposed to have already collected Groq, NVIDIA, Google, Anthropic, Codex, Cursor, and ElevenLabs; a missing Supervisor route is an Issue, not an invitation to skip setup.

## Prompt inputs

- Global or project instructions (config_versions)
- Recent messages in that conversation (bounded)
- Matching `memory_items` (global if `project_id` is null; plus project items if scoped)
- Tool catalog below
- Never a project-owned profile that is not allowlisted for Supervisor
- Confidential project bodies: ADR 005 `metadata_only`

## Tool catalog (exhaustive for V1 Supervisor)

The model cannot exec, read host files, or call the broker’s GitHub admin.

| tool | does |
|---|---|
| `memory.upsert` | Store/update a note. `project_id` optional (null = global). |
| `memory.search` | Keyword search memory. |
| `project.onboarding_start` | Create `onboarding_sessions` (status=in_progress). |
| `project.onboarding_set` | Set one answered field from TEMPLATES. |
| `project.onboarding_finalize` | Insert `projects` row when required fields present. GitHub may be null. |
| `project.list` | Name, type, confidentiality. |
| `issue.create` | If the Supervisor is blocked. |
| `connection.request` | Open UserActionRequest for a missing key (model, GitHub later). |

Heavy engineering (`github.*`, harness spawn) is **not** a Supervisor tool. Those are task-lane / broker after Phase 4.

## Onboarding fields (TEMPLATES)

Required to finalize: `name`, `slug`, `project_type` (personal\|professional).

Required if professional: confidentiality, production_status, customer_facing, metered_spend_allowed (default false), which existing auth profiles may be used (default: none until listed; personal profiles may be offered as checkboxes).

Optional until later: GitHub owner/repo, deploy policy. Finalize is allowed with `github_repo` null; engineering tasks then wait on Issue “connect repository.”

## Turn persistence

User message → Inbox Event → `messages` row. Assistant message → `messages` row. Each tool call → `task` only if it starts durable work; memory upsert is not a heavy task.

SSE: `conversation.message` after each assistant message.

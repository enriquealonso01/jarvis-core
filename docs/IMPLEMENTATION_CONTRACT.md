# Jarvis V1 implementation contract

> **Written against `JARVIS_V1_MASTER_PLAN_v1.2.md`, which is superseded.**
>
> **Still useful for wiring, defaults and mechanics** where the v2 plan does not
> contradict it — that is what it was for and it is good at it. **Never for
> product, sequencing, or "what should exist".** Its section references point at
> v1.2's numbering. Where it and `JARVIS_MASTER_PLAN_V2.md` disagree, the plan
> wins.

**Status:** accepted with the ADRs  
**Product freeze:** `JARVIS_V1_MASTER_PLAN_v1.2.md`  
**Purpose:** Specify every mechanic the plan left implicit so implementation does not invent product or architecture. This document does **not** add features. It binds wiring, defaults, and “how.”

Single operator: Enrique. Build isolation, durability, and recovery. Do not build multi-tenant SaaS.

Language: TypeScript/Node 22 for Core (ADR 011). Control Center: Next.js. Schema: raw SQL migrations.

---

## How to use this document

Each heading is a master-plan section. If you implement that section, you implement the bullets here. Pointers to ADRs and other docs are normative.

---

## Part I — Product and infrastructure

### §1 Product identity

Jarvis code treats **models as adapters**. Personality, memory, permissions, and task state are Postgres (+ encrypted files). No “the Claude is Jarvis” session that owns truth.

### §2.1 Hosting

- Month-to-month Netcup; preferred RS 2000 G12 Manassas 8c/16GB/512GB.
- If unavailable: ≥16 GB RAM beats extra disk (ADR 007).
- Record actual SKU in `config/site.yaml`.
- OS: Debian 13 Trixie on the current Netcup host (Ubuntu LTS also acceptable). Unattended-upgrades for security. SSH keys only (ADR 009).

### §2.2 Frontend hosting

- Repo `jarvis-control-center` is the UI.
- Netlify: **PR previews**. Production UI is served same-origin by Caddy on Netcup (ADR 004). Netlify production proxy is an allowed equivalent, not a second source of truth.
- No secrets, no Inbox, no tokens in Netlify env except public site URL.

### §2.3 Backend hosting

One Compose stack on the Netcup box: Caddy, API, Postgres, OpenClaw, worker supervisor. Layout: `docs/SERVER_LAYOUT.md`.

### §2.4 Supabase

Do not add Supabase client, hosted DB, or hosted auth. Local Postgres only.

### §3 OpenClaw

- OpenClaw is runtime; Jarvis is brain (ADR 001, 002).
- Do not reimplement WhatsApp, cron clock, ACP spawn, or voice media.
- Do not use OpenClaw SQLite as the Control Center database.
- Ship `jarvis-bridge` plugin before calling WhatsApp “integrated.”

### §4 Coding harnesses

- V1 adapters: Claude Code (subscription), Codex (subscription), Cursor Agent (ACP). OpenCode optional if ACP target works with no extra product. OpenHands: not V1.
- Harness auth: ADR 006.
- No harness writes Jarvis product tables.

---

## Part II — System projects

### §5.1 Jarvis Core

This repo. Owns API, schema, broker, bridge, Compose, Improvement/Maintenance jobs as code.

### §5.2 Jarvis Control Center

Separate repo. No OpenClaw admin token, no DB URL, no master key, no provider secrets.

### §5.3 Integrations

V1: `packages/integrations` in Core (ADR 010). MCP servers, Composio adapters, connection manifests, permission schemas, tests.

**Composio (accounted, not expanded):** a connection kind `composio`. User completes Composio OAuth via UserActionRequest. Jarvis stores the Composio account id + encrypted API key in the broker. Tools are invoked through the integrations package. Do not build a Composio control plane. If Composio is unused at launch, the kind still exists so adding it is config, not a new architecture.

### §5.4 Improvement

- System project `jarvis-improvement`, weekly schedule (default Monday 10:00 America/New_York), priority Low/Background.
- May: web research, record candidates, clone **to an isolated sandbox** with **no harness-auth mounts**, run listed static checks, write a recommendation artifact, open an Issue for user approval.
- May not: enable providers, paid plans, untrusted MCP in production, weaken isolation, change always-confirm.
- Untrusted MCP/code never runs on the host network with broker credentials. Sandbox network default: none, then allowlist if the test requires.

### §5.5 Maintenance

- System project `jarvis-maintenance`. Schedules: health every 5 minutes (system lane, not heavy), daily retention, weekly docker/worktree prune, monthly restore test Issue if not run.
- Auto: restart disposable browser/worker, retry bounded calls, log rotate, prune approved temps, fail over among **already approved** models, reconcile OpenClaw drift.
- Not auto: anything in §13.3, billing, isolation, destroying data outside retention.

---

## Part III — Data ownership

### §6.1–6.2

ADR 001. External IDs: `openclaw:session:<id>`, `openclaw:automation:<id>`, `openclaw:task:<id>`.

### §6.3 Queue

Postgres. `FOR UPDATE SKIP LOCKED`. Lease 60s, heartbeat 15s. Attempts table. Dead-letter → Issue, task `failed_terminal`. No Redis/Valkey in V1.

### §6.4 Files

Root: `/var/lib/jarvis/artifacts/<project_id>/<yyyy>/<mm>/<id>`. Metadata in `artifacts`. SHA-256, MIME sniff, size cap (default 50 MB inbound, 200 MB generated; oversize → Issue). Quarantine dir until scan/sniff passes. Encrypted backup via restic, not a second object store in V1.

---

## Part IV — Projects, connections, secrets

### §7 Isolation

Enforce with: Docker for untrusted/generic tools; Unix uid split for harness (ADR 006); project mounts only; browser profile per project; broker checks; no host docker.sock in project containers.

**Initial projects to create in Phase 1 seed (ADR 012):**

| slug | type | notes |
|---|---|---|
| jarvis-improvement | system | weekly research; seeded |
| jarvis-maintenance | system | health/retention; seeded |

No other projects. `jarvis-core` and `jarvis-control-center` are git repos we implement, not seeded work projects. Application and professional projects are created later through Control Center chat (global Supervisor conversation) or WhatsApp. Personal apps: each a project, never a catch-all “Personal.”

### §8 Connection scopes

Schema: `connections.scope` ∈ `system | shared | project | task_ephemeral`. `auth_profiles` are first-class (DATA_MODEL). Broker resolves **profile id**, not provider name.

Required seed profiles: as plan §8.5 (`anthropic_personal`, `openai_codex_personal`, `cursor_personal`, `github_personal_admin`). Per-repo GitHub credentials and any project-owned model profiles are created at project onboarding, not at boot.

### §9 Credential broker

See `docs/CREDENTIAL_BROKER.md`. Every listed capability is the API; do not add a generic `run_shell_with_all_secrets`.

### §10 GitHub

ADR 003. High-risk actions always-confirm.

### §11 Netlify

System connection. Capabilities: `netlify.create_site`, `create_deploy`, `promote_deploy`, `connection.test`. Control Center site id stored on that project. Workers never see the master token. Production Control Center may be Caddy-served; Netlify still used for previews and remains a brokered system connection for other personal sites.

### §12 Human connection flow

Issue + `UserActionRequest` + WhatsApp short link (ADR 004). Control Center page fields: exactly the list in §12. Submit to API. Test connection. Resume blocked tasks.

---

## Part V — Authorization

### §13.1 Baseline autonomous

Allowed under project policy without extra click: the §13.1 list. Implementation: `policy.baseline_actions` on the project, defaulting to that list.

### §13.2 Task grants

Parse authenticated user text (WhatsApp from allowlisted owner number, UI, inbound call **after** call auth — not caller ID alone). Persist `task_grants` bound to project, task, repo, env, expiration (default 4 hours), expected actions.

Invalidation: the §13.2 bullet list. SHA binding: grant records `allowed_sha` after tests; merge/deploy checks SHA.

### §13.3 Always-confirm

Hardcoded in API. Cannot be removed by project instructions or Improvement. UI + WhatsApp deep link. Bound per §13.4.

### §13.4 Approval binding

Columns: action_type, project_id, target, environment, resource_version (SHA), expires_at, task_id. SHA A ≠ SHA B.

---

## Part VI — Input and communication

### §14 Inbox

See DATA_MODEL `inbox_events`. Dedup key: `channel + external_event_id` or content checksum + sender + timestamp bucket (5s) if no external id. Capture state vs processing state are separate columns so “stored but not classified” is visible.

Sources: implement all listed; webhook and connection callback share the ingest authenticator.

### §15 Conversations and tasks

ADR 005. Correlation window **10 minutes**. Objects: Inbox Event, Conversation, Task, Artifact, Issue — never collapse into one chat table.

**Global Supervisor conversation:** Control Center chat with no project selected (and WhatsApp when no project directive hits) attaches here. First-run: operator pastes documentation and asks Jarvis to create projects. Does not require an application project row.

### §16 WhatsApp

- Dedicated number; allowlist in `channel_allowlist`.
- Pairing: QR via Tailscale/SSH to the operator; documented in SERVER_LAYOUT. Not a Control Center secret dump.
- WhatsApp **calling** (MeowCaller) disabled. Telnyx is the phone path.
- Media: download to artifacts, then STT/vision per project eligibility.

### §17 Notifications

Outbox table. Worker on system lane. WhatsApp brevity rules implemented as `notification_policy` keyed by message type: `silent_capture | ack_optional | long_running | weekly_report | blocker`. Failed send does not mark task delivered. Idempotency key: `type + object_id + attempt_bucket`.

### §18 Phone

Telnyx + OpenClaw voice-call + ElevenLabs. Public webhook = Jarvis/Caddy (ADR 009). Approvals never by caller ID: inbound call can **talk**, but always-confirm still needs Control Center or a spoken confirmation **plus** a signed action already opened, or a PIN stored hashed (optional V1: **do not** add PIN unless needed; default is “call discusses, confirm in UI/WhatsApp link”). Locked default: **phone cannot complete §13.3**; it can only request the link. Inbound anytime; outbound quiet hours §18.1.

### §18.2 Audio retention

Daily job. Delete raw files where `retain_until < now()` and `permanent=false`. Hard fail if any raw audio older than 10 days and not permanent (Issue `security.retention_breach`). UI: deletion date + Keep permanently.

### §19 Voice

ElevenLabs voice_id in config. Monitor usage via API; if billed usage approaching cap, Issue. No auto top-up. No Kokoro/Chatterbox.

---

## Part VII — Queue and recovery

### §20 Lanes

- Supervisor: always. Model from Supervisor-eligible profiles (never a project-owned profile allowlisted only for another project).
- Heavy: concurrency 1 (ADR 007).
- System: scheduler, watchdog, outbox, STT intake, health, backup, maintenance. Must not wait on heavy.

### §21 Queue rules

Priorities enum. Fairness ADR 007. Pause/resume/cancel in API. Dependencies: `task_dependencies` wait until predecessors `succeeded`.

Relentless processing: system worker claims queued work until a terminal wait state.

### §22 User feedback during execution

New instruction → Inbox first. Router decides update current / update queued / new task / config task. UI shows `routed_to`. User correction writes override.

### §23 Task state machine

`docs/STATE_MACHINES.md`. Every transition → `task_transitions` (at, cause, actor, event_id).

### §24 Watchdog

Heartbeats from heavy worker. Hang if: no heartbeat 90s, or no progress event for tool-specific timeout (default 15 min coding, 5 min browser page, 3 min HTTP). Recovery ladder §24 as ordered functions; each step audited. Bounded retries: 5 with expo backoff 2^n seconds + jitter, cap 10 minutes.

### §25 Checkpoints

At: after plan, after each commit, after tests, every 10 minutes while running. Stored in `task_checkpoints` JSONB (fields in plan §25). Resume loads latest successful checkpoint.

### §26 Schedules

Postgres canonical; OpenClaw executes (ADR 001). Default tz America/New_York. Overlap default `skip` for heavy templates, `queue` for light. Misfire: if missed < 15 min, run once; else skip + Issue. Max catch-up 1. Repeated failure (3) → Issue, pause schedule.

---

## Part VIII — Engineering

### §27 Workflow

Implement as a **task phase enum** matching the 19 steps (condensed phases: reproduce → plan → implement → test → review → pr → grant-gated merge). Skip merge/deploy without grant/approval. If cannot reproduce: artifact + confidence, no silent “fix.”

### §28 AGENTS.md

Each managed repo gets template from `docs/TEMPLATES.md`. Jarvis reads it at task start. Onboarding questions: TEMPLATES. Professional/confidential defaults: plan §28.2 (generic), ADR 005.

### §29 Independent review

Prefer different family than implementer. If only one family is allowlisted for a project, a second context/model of that family may review. Reviewer does not get merge right.

### §30 Eval suite

Private dataset in Core (not public). Not a launch blocker for first WhatsApp loop; it **is** a Phase 6/7 item. Do not skip it in the architecture — tables `benchmarks` exist from Phase 1.

---

## Part IX — Models

### §31–34

Registry in Postgres. Route = role + model + provider + auth_profile + project_policy. OpenClaw failover only among Jarvis-preapproved pairs. Failover that would switch **account** is denied (Issue). Pin versions; no raw `latest` in production routes.

### §35 Candidates

Discover at deploy time; seed file `config/models.seed.yaml` is a **hint list**, not a promise. Improvement refreshes weekly.

### §36 Free-tier

Improvement job verifies quota/terms. Confidential projects: exclude consumer/free unless exception column on project.

### §37 Cost

`auth_profiles.metered_spend_allowed` default false. `spend_ceiling_cents` null. Hitting quota → degrade + Issue, never enable billing.

---

## Part X — Control Center

Screens and APIs: `docs/CONTROL_CENTER.md`. Design tokens: dark graphite, cyan/blue accent, etc. as §43 — implementation in the UI repo, not here. SSE: `GET /api/events`. WebSocket only for future terminal/browser interactive; V1 can skip WS if no in-browser terminal yet, but the **Work** view still shows tool events via SSE. Do not fake progress %. Stale banner if SSE disconnect > 5s.

### §44 Browser never receives

Gateway token, DB URL, master key, unrestricted MCP. Enforced by API response allowlists.

---

## Part XI — Issues and observability

Error classes: `docs/ERROR_TAXONOMY.md`. Health: system lane. Logs: JSON, correlation ids (`inbox_event_id`, `conversation_id`, `task_id`, `execution_id`, `issue_id`). Redact secrets (bearer, pem, `sk-`, `ghp_`). No full audio/documents in app logs (store artifact ids).

---

## Part XII — Security

SERVER_LAYOUT hardening list. File safety: size, sniff, normalize names, quarantine, ClamAV if package is cheap on Ubuntu; if ClamAV is too heavy for 16 GB, skip and keep quarantine + no-exec + sandbox — record in site.yaml `malware_scan: clamav|off`. Default try ClamAV; shed if RAM policy trips.

---

## Part XIII — Backup

Restic → B2. Daily incremental. Weekly keep, monthly keep. `jarvis backup|verify-backup|export|restore` as documented commands (scripts in Core). Restore test monthly → Issue if overdue. OAuth that cannot migrate → UserActionRequest post-restore.

---

## Part XIV — Self-improvement

Weekly Improvement as §58. Immutable boundaries §59 hardcoded. User-directed config changes: versioned `config_versions`, rollback, audit. “What changed in this project's policy last week?” = query `config_versions` + audit.

---

## Part XV — Cost

No surprise APIs. Resource forecast: Maintenance weekly disk projection; Issue at 70% disk, Critical at 85%.

---

## Part XVI — Phases

`docs/PHASE_CHECKLIST.md`. Phases are **order**, not permission to forget later sections. Schema for later phases is created in Phase 1 even if the worker is stubbed (so we do not redesign tables later).

---

## Part XVII — Acceptance

Every test in `docs/FULL_LOOPS.md` with expected side effects. V1 launch = all **critical** loops green (FULL_LOOPS marks them).

---

## Part XVIII–XX

Preferences already in plan §87–91; mechanics above. External URLs revalidated at implement time; if OpenClaw behavior changed, write an ADR — do not quietly drop persist-first.

---

## Explicitly out of V1 (plan already excluded)

- WhatsApp calling
- Supabase
- Redis/Valkey unless proven
- Chatterbox/Kokoro
- OpenHands unless later ADR
- Multi-user
- Automatic paid top-ups
- Parallel heavy runs

## Not new product — accounted so nobody “adds” them mid-build

- `jarvis-bridge` ingest
- Reconciliation job
- Unix users for harness isolation
- Deploy key **and** repo API credential
- Same-origin Caddy
- Deterministic router
- Outbox
- Quiet hours gate on Telnyx outbound
- Audio GC job

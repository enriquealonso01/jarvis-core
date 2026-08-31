# Jarvis V1 documentation

v1.2 of the master plan is the **current product baseline** (ADR 012). v1.1 is historical. Everything else in this folder specifies mechanics so implementation does not invent architecture.

## Product

- [JARVIS_V1_MASTER_PLAN_v1.2.md](JARVIS_V1_MASTER_PLAN_v1.2.md) — canonical product, security, and preference decisions
- [JARVIS_V1_MASTER_PLAN_v1.1.md](JARVIS_V1_MASTER_PLAN_v1.1.md) — historical (named TicketFlipping tenant; superseded)

## Implementation (read before coding)

- [IMPLEMENTATION_CONTRACT.md](IMPLEMENTATION_CONTRACT.md) — section-by-section wiring of the plan; no new product features
- [DATA_MODEL.md](DATA_MODEL.md) — Postgres schema
- [STATE_MACHINES.md](STATE_MACHINES.md) — Inbox, task, issue, grant, connection, schedule
- [API_AND_EVENTS.md](API_AND_EVENTS.md) — HTTP, SSE, internal ingest
- [CREDENTIAL_BROKER.md](CREDENTIAL_BROKER.md) — capability catalog and checks
- [FULL_LOOPS.md](FULL_LOOPS.md) — every acceptance test as a concrete flow
- [ERROR_TAXONOMY.md](ERROR_TAXONOMY.md) — failure handling table
- [SERVER_LAYOUT.md](SERVER_LAYOUT.md) — disk, Compose, RAM, ports, backups
- [PHASE_CHECKLIST.md](PHASE_CHECKLIST.md) — phase deliverables and exit criteria
- [OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md) — plugin, IDs, reconciliation
- [CONTROL_CENTER.md](CONTROL_CENTER.md) — screens mapped to APIs
- [TEMPLATES.md](TEMPLATES.md) — AGENTS.md, onboarding, Issue copy
- [WORKERS.md](WORKERS.md) — claim, heartbeat, checkpoint JSON
- [FIRST_SLICE.md](FIRST_SLICE.md) — first slice **on Netcup**
- [SUPERVISOR.md](SUPERVISOR.md) — turn loop and tool catalog
- [NETCUP_BOOTSTRAP.md](NETCUP_BOOTSTRAP.md) — I cannot order the VPS via API; you order, then SCP for Jarvis

## Architecture decisions

| ADR | Decision |
|---|---|
| [001](adr/001-openclaw-state-ownership.md) | Postgres owns product state; OpenClaw owns runtime; inbound persist-first |
| [002](adr/002-projects-vs-openclaw-agents.md) | One Supervisor agent; Jarvis projects are not OpenClaw agents |
| [003](adr/003-github-credentials.md) | Admin credential + per-repo git key + per-repo API credential |
| [004](adr/004-single-user-auth.md) | One user, same-origin session cookie, signed action links |
| [005](adr/005-supervisor-routing.md) | Deterministic router before any LLM; confidential bodies never hit ineligible models |
| [006](adr/006-harness-host-auth.md) | Subscription logins on host per auth profile; cwd is the project worktree |
| [007](adr/007-ram-and-queue-fairness.md) | 16 GB budget; heavy concurrency 1; starvation cap |
| [008](adr/008-secret-storage.md) | Envelope encryption; master key on disk; restic for backup |
| [009](adr/009-network-exposure.md) | Public: API + Telnyx webhook; OpenClaw/Postgres/SSH private |
| [010](adr/010-bootstrap-and-repos.md) | Manual Phase 0; two repos; integrations as a Core package |
| [011](adr/011-implementation-language.md) | TypeScript/Node 22 for Core; SQL migrations |
| [012](adr/012-v1-seed-projects-only.md) | Seed only Improvement and Maintenance; no named customer project |
| [013](adr/013-first-slice-and-bootstrap.md) | Talk slice + Supervisor loop (hosting superseded by 014) |
| [014](adr/014-netcup-only-full-provider-bootstrap.md) | Netcup only; collect all declared providers at setup |

New architectural change: copy `adr/TEMPLATE.md`, increment the number, get user approval if it touches isolation, billing, or always-confirm.

## Config placeholders

Copy `config/site.example.yaml` to `config/site.yaml` at bootstrap (gitignored). Domain, Tailscale, and backup destination are not invented in code.

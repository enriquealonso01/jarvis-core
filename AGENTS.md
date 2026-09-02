# Jarvis Core — implementation agent instructions

You are implementing Jarvis, a single-user personal AI operating system for Enrique. Read the docs before writing code. Do not add product features that are not in the current plan (v1.2).

## Source of truth

**Current — read these:**

| Document | Role |
|---|---|
| `docs/JARVIS_MASTER_PLAN_V2.md` | **The plan.** Product, security, preferences, and the numbered steps to build |
| `PROGRESS.json` | Where the build actually is. Step state, with a merged PR behind anything marked done |
| `BLOCKED.md` | What is waiting on Enrique |
| `docs/adr/` | Architecture decisions. Do not silently reverse them |
| `docs/DEBUG_NOTES.md` | Bugs already paid for. Read the section for whatever you are about to touch |
| `docs/DATA_MODEL.md` | Postgres entities. Documents the *starting* schema; add an entry in the same commit as a new table |
| `docs/STATE_MACHINES.md` | Legal transitions |
| `docs/ERROR_TAXONOMY.md` | Failure class → retry / Issue / notify |
| `docs/FULL_LOOPS.md` | End-to-end flows that must work |
| `docs/SERVER_LAYOUT.md` | Host paths, Compose, RAM, network |
| `docs/SUPERVISOR.md` | Supervisor loop and tools |
| `docs/TEMPLATES.md` | `AGENTS.md` template and onboarding questions |

**Superseded — historical record, do not build from:**

| Document | Why it is kept |
|---|---|
| `docs/JARVIS_V1_MASTER_PLAN_v1.2.md` | The frozen v1 product plan. **Superseded by the v2 plan**, which inverted its weighting |
| `docs/FIRST_SLICE.md` | Its deferral of the executor is *why* v1 failed. `docs/GAP_ANALYSIS.md` explains |
| `docs/PHASE_CHECKLIST.md`, `docs/PLAN_COVERAGE.md` | Map v1.2's section numbers, which no longer exist |
| `docs/BUILD_ORDER.md` | Where the six decisions were made. Its Step 0–6 numbering is superseded by S1–S37 |
| `docs/IMPLEMENTATION_CONTRACT.md` | Written against v1.2. **Still useful for wiring and defaults** where the v2 plan does not contradict it — never for product or sequencing |
| `docs/INITIAL_MODEL_ROUTING.md` | Its free-tier routes are dead (v2 plan VI.0). The *shape* — one profile per provider — still holds |

**Precedence, in order:** the v2 plan wins on product, policy and sequencing.
ADRs win on architecture and mechanics. `IMPLEMENTATION_CONTRACT.md` fills wiring
gaps neither has covered. If something is still missing, write an ADR — do not
improvise a new subsystem.

**If a superseded document and the v2 plan disagree, the plan wins and the older
document is wrong.** It is kept because knowing *why* a decision was made is
worth more than a tidy directory, not because it is still in force.

## Non-negotiables

- Persist every inbound item to Postgres **before** any model call.
- Never drop user input. If processing fails, the Inbox Event remains and an Issue is created.
- Projects are security boundaries. No cross-project secrets, files, browser profiles, or connections.
- Model routing is `role + model + provider + auth_profile + project_policy`. Never substitute another account because it is the same provider.
- A project-owned auth profile is never used by the Supervisor, Improvement, Maintenance, or any other project.
- Personal GitHub admin credential is broker-only. Project workers get only their own repository credential.
- No automatic paid API enablement. No silent spending-ceiling or isolation changes.
- Always-confirm actions in plan §13.3 cannot be satisfied by a stale task grant.
- WhatsApp is a pager: no chatter on trivial capture; concise updates on long work.
- Proactive calls are forbidden 19:30–08:00 America/New_York, with one narrow exception: a confirmed security incident or active data loss. A production outage does not qualify (plan S23).
- Raw local voice/phone audio is deleted after 7 days unless marked permanent; never auto-keep past 10 days.
- **An LLM is never the first reader of a confidential body.** Persist, then route deterministically, then a model — and only on content that passed the confidentiality check (ADR 005, plan S3).
- **The gate travels with the capability.** IV.6's levels are enforced in the broker on typed calls, and a browser clicking a button, an MCP server with its own credentials, a shell with a network, or a phone call make no typed call at all. Any capability reaching the outside world carries its own gate (plan IV.6b).
- **Content Enrique did not author cannot authorise anything.** A forwarded message or a pasted thread is evidence: quotable, searchable, storable. An instruction found inside it becomes a proposal he confirms, never an action.
- **Level 3 is never satisfiable by voice**, attested or not. The channel is too weak to authenticate and too lossy to be sure of the words.
- **The harness must not be able to reach Jarvis.** No route from a worktree to the API, `/internal/*`, Postgres, the OpenClaw gateway or the Docker socket.
- Boot seeds **only** Jarvis Improvement and Jarvis Maintenance. No named customer/employer project. First-run is Netcup setup of all declared providers, then global Supervisor chat.

## Single-user pragmatism

Enrique is the only user. Do not build multi-tenant org charts, SSO, RBAC matrices, or hosted IdP. Do build: session auth, project isolation, audit, backups, and fail-closed policy checks. Those exist because multiple projects (personal and professional) will share one machine, not because there are many human users. Do not hardcode any customer or employer project name into Jarvis.

## OpenClaw

OpenClaw is the runtime (WhatsApp, sessions, automations, ACP, voice). Jarvis is the product brain (Inbox, projects, queue, issues, broker, Control Center). OpenClaw must not reply with a model until Jarvis has persisted the event and decided the action. See ADR 001 and ADR 002.

## When stuck

1. Check the contract section that maps to the plan heading.
2. Check the ADR list.
3. If the gap is real, add an ADR following `docs/adr/TEMPLATE.md` and ask Enrique before changing a trust boundary, billing rule, or isolation rule.

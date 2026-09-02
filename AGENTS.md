# Jarvis Core — implementation agent instructions

You are implementing Jarvis, a single-user personal AI operating system for
Enrique. Read the docs before writing code. Do not add product features that are
not in the current plan.

## Read in this order, before touching anything

1. **`docs/JARVIS_MASTER_PLAN_V2.md`** — the plan being executed. Start at 0.0
   "Start here" and 0.5, then Part III, which is the backlog. **V2 supersedes
   `docs/JARVIS_V1_MASTER_PLAN_v1.2.md`**, which is kept only as history.
2. **`PROGRESS.json`** — which step is current, what is done, what is blocked,
   and the evidence behind each claim. `git log --oneline -20` is the check on it.
3. **`BLOCKED.md`** — everything waiting on Enrique, and anything left in flight.
   Re-read it every session; if something there is now unblocked, finish it
   before starting anything new.
4. **`docs/DEBUG_NOTES.md`** — bugs already paid for. Read before you write.
5. This file, for the non-negotiables below.

## Source of truth

| Document | Role |
|---|---|
| `docs/JARVIS_MASTER_PLAN_V2.md` | **The plan.** Product, security and preference decisions, and the S1–S37 backlog |
| `PROGRESS.json` / `BLOCKED.md` | Where the build actually is, and what is waiting on Enrique |
| `docs/JARVIS_V1_MASTER_PLAN_v1.2.md` | Superseded by V2. History only — do not execute from it |
| `docs/IMPLEMENTATION_CONTRACT.md` | How each plan section is implemented; fills every gap |
| `docs/adr/` | Architecture decisions. Do not silently reverse them |
| `docs/DATA_MODEL.md` | Postgres entities, columns, indexes |
| `docs/STATE_MACHINES.md` | Legal transitions |
| `docs/FULL_LOOPS.md` | End-to-end flows that must work |
| `docs/ERROR_TAXONOMY.md` | Failure class → retry / Issue / notify |
| `docs/SERVER_LAYOUT.md` | Host paths, Compose, RAM, network |
| `docs/PHASE_CHECKLIST.md` | What ships in which phase, exit criteria |
| `docs/PLAN_COVERAGE.md` | Every plan section mapped to a spec |
| `docs/FIRST_SLICE.md` | First slice on Netcup |
| `docs/SUPERVISOR.md` | Supervisor loop and tools |
| `docs/INITIAL_MODEL_ROUTING.md` | Bootstrap model routes from plan §35 |

If a plan sentence and the contract disagree on **product policy**, the plan wins. If they disagree on **wiring or mechanics**, the contract and ADRs win. If something is still missing, write an ADR; do not improvise a new subsystem.

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

# Phase checklist

> **SUPERSEDED by `JARVIS_MASTER_PLAN_V2.md`. Do not sequence work from this file.**
>
> Its phases map onto v1.2's section numbers, which no longer exist. The plan's
> S1–S37 replace them. Kept as the record of how the work was originally
> divided.

Schema for **all** tables in DATA_MODEL is migrated in **Phase 1**. Later phases fill workers, not new product concepts.

Exit a phase only when its exit criteria are true. Do not skip Core tables because “UI is next.”

---

## Phase 0 — Foundation

**Required first.** Jarvis does not run on a laptop (ADR 014).

**Do**

- Manual private repos: `jarvis-core`, `jarvis-control-center` (ADR 010)
- This docs tree is the first `jarvis-core` commit
- Netcup month-to-month, harden SSH, UFW, Tailscale
- DNS + Caddy TLS for `jarvis.<domain>`
- B2 bucket + restic init + first empty backup
- Unix users and `/var/lib/jarvis` dirs
- Document SKU in `site.yaml`
- Compose stack on **this** VPS

**Do not** wait for the broker to create Core. **Do not** treat laptop Docker as the Jarvis host.

**Exit:** SSH keys-only, TLS works, restic snapshots, Tailscale ping, API reachable at `https://jarvis.<domain>`.

---

## Phase 1 — Persistence and auth

**Do**

- Migrations for entire DATA_MODEL
- Login cookie (ADR 004)
- Seed **only** jarvis-improvement and jarvis-maintenance + default schedules (ADR 012)
- Seed auth_profile **rows** and **collect credentials** for every bootstrap profile in INITIAL_MODEL_ROUTING.md
- Verify live catalogs; write initial `model_registry` routes
- Global Supervisor conversation ready for UI chat
- Supervisor turn loop + tools (`docs/SUPERVISOR.md`) — chat blocked until Supervisor route is healthy
- `onboarding_sessions` + create-project from chat (GitHub optional)
- Inbox ingest from UI
- Tasks + SKIP LOCKED queue + outbox table (worker can be stub)
- Issues + audit
- Config versions

**Exit:** L1 (UI ingest), login, restart does not lose Inbox rows (L2 subset). Supervisor compose disabled until the Supervisor route is healthy. All §35 API-key providers stored (or Issues if a catalog/login failed).

All of this runs on Netcup.

---

## Phase 2 — OpenClaw and channels

**Do**

- OpenClaw + `jarvis-bridge` (ADR 001)
- Dedicated WhatsApp, allowlist, QR runbook
- Schedule sync + fire
- Auth profiles wired for personal Anthropic/Codex/Cursor as logins exist
- Sandbox policy defaults
- Notification worker + brevity
- Reconciliation job

**Exit:** L1 WhatsApp, L10, L14, L4 (failover without enabling paid).

---

## Phase 3 — Control Center

**Do**

- All nav in plan §38 as routes (can be sparse widgets, not fake data)
- **Global chat** on Home / Conversations with no project selected (first-run)
- Composer **disabled** until a Supervisor route is healthy
- First-run **provider checklist** (Groq, NVIDIA, Google, Anthropic, Codex, Cursor, ElevenLabs, GitHub admin, B2) — ADR 014
- Create-project onboarding in that chat (TEMPLATES; GitHub may be deferred)
- Home health, Work, Queue, Conversations, Issues, Approvals, Connections, Schedules, Models, Artifacts, Improvement, Maintenance, Settings/Audit
- Action-request pages
- SSE
- Mobile bottom nav
- Production static on Caddy

**Exit:** L0 (create project from chat), L16, L17, stale SSE banner.

---

## Phase 4 — Engineering

**Do**

- GitHub admin + per-repo keys (ADR 003)
- Worktrees
- Harness spawn (ADR 006)
- Onboarding flow already in Slice A; Phase 4 adds GitHub/repo wiring onto existing projects
- Review + PR pipeline
- Netlify broker
- Task grants + always-confirm

**Exit:** L0b, L5–L9, L11, L7 on a personal repo created during the test.

---

## Phase 5 — Voice and phone

**Do**

- Telnyx webhook, inbound/outbound
- ElevenLabs
- Call → Inbox
- Quiet hours gate
- 7-day audio job
- Phone cannot pass §13.3 (contract)

**Exit:** L12, L13.

---

## Phase 6 — Reliability and self-management

**Do**

- Watchdog ladder
- Checkpoints resume (if not already from Phase 4)
- Improvement weekly
- Maintenance jobs
- Benchmark suite harness
- Restore test
- Isolation tests automated

**Exit:** L3, L15, L18, L19.

---

## Phase 7 — Acceptance freeze

Run FULL_LOOPS critical set. Record results in `docs/acceptance/` (date, pass/fail). Launch only if critical all pass.

No new product surface in Phase 7. Fixes only.

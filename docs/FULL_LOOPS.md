# Full loops

Each loop is a launch-quality path. **Critical** loops must pass before V1 is called launched (plan §70). Others are still specified so they are not redesigned later.

Related Inbox Event, Task, Issue, and audit rows are named so tests can assert them.

---

## L1 — WhatsApp capture while busy (critical) — plan §71

1. Heavy task T1 running (any personal project).
2. User sends WhatsApp text, then voice note, then image, within seconds.
3. Bridge ingest persists 3 Inbox Events (`capture_state=persisted`) **before** Supervisor tokens.
4. Outbox: no completion spam for “store/transcribe” if classified trivial; optional none.
5. Voice: artifact raw_audio + STT per ADR 005; transcript message linked.
6. Kill API for 10s mid-send: OpenClaw retries ingest; reconciliation inserts any miss; **no drop**.
7. UI conversations show provenance `inbox_event_id`.

Phone and UI compose in the same test pass: same persist-first path.

---

## L2 — Queue / process restart (critical) — §72

1. Tasks queued + one running with checkpoint.
2. `docker compose restart` API + workers (Postgres stays).
3. Running task → `stalled` then `recovering`; resume from latest checkpoint.
4. Queued still queued, order preserved.

Also: full VM reboot; Postgres starts before API (Compose depends_on healthy).

---

## L3 — Kill heavy worker (critical) — §73

1. Kill harness PID or container.
2. Watchdog: missed heartbeat → Issue `worker.crash` + task `stalled`/`recovering`.
3. Replacement starts with same worktree + checkpoint.
4. User WhatsApp: only if recovery exceeds 5 minutes or needs user (plan: concise blocker).

---

## L4 — Model failover (critical) — §74

1. Mark Supervisor primary unhealthy in registry.
2. Next Supervisor turn uses next **approved** pair (same role, eligible profile).
3. Conversation ids unchanged.
4. Exhaust pool → Issue `provider.degraded`; **no** metered enable.
5. Attempt to use a **temporary** project-owned profile (created in the test) for Supervisor → deny + audit (§80.1).

---

## L5 — Connection repair (critical) — §75

1. Delete/expire GitHub API credential for a project.
2. Next `github.open_pull_request` → one Issue (dedupe) + WhatsApp link.
3. User submits new PAT on action page; secrets to API.
4. `connection.test` ok; Issue resolved; blocked task `queued`.
5. Provider-level profile reused, not a new duplicate profile.

---

## L6 — Two personal repos isolation (critical) — §76

1. “Create project Alpha” and “Create project Beta” (natural language or UI).
2. Two private repos; two deploy keys; fingerprints differ.
3. Worker A cannot `git ls-remote` B (assert).
4. Worker A cannot read `github_personal_admin` (assert).
5. A professional project's credential (if one exists in the test) cannot fetch Alpha (assert).
6. Audit: repo create + key register.

---

## L7 — Task grant merge/deploy — §77

1. Allowlisted user: “Fix this, create the PR, merge it, and deploy it” on a **non-production** personal site or Control Center preview policy as configured.
2. Grant row stored; tests+review still run.
3. Merge without second click if SHA matches.
4. Amend commit after tests → grant invalidate → approval Issue.

For any **production** professional project: `nl_grant_may_deploy_production` defaults to **false**. Natural-language “merge and deploy” does not ship production until that flag is on. Create that project in the test; do not seed a named tenant.

---

## L8 — Always-confirm (critical) — §78

Project agent asks broker `github.admin.delete_repository` or isolation weaken → pending approval, no execution.

---

## L9 — Cross-project probe (critical) — §79

Task in Alpha requests Beta secret, Beta files, Beta browser dir, Beta connection name → 403, audit `security.isolation`.

---

## L10 — WhatsApp brevity — §80

Trivial “remember this” → no completion WhatsApp. Long engineering-style fake task → ack + completion with link, no mid chatter if healthy.

---

## L11 — Auth profile isolation (critical) — §80.1

Create a temporary professional project with a dedicated auth profile. Attempt to use that profile for a personal/system task, and attempt to send that project's code through a personal/free profile → deny before HTTP to provider; audit.

---

## L12 — Audio GC — §80.2

Ingest audio; clock-test job +7d: raw gone, transcript remains. +10d without permanent: none left; else Issue.

---

## L13 — Quiet hours (critical once phone ships) — §80.3

System clock 20:00 NY: outbound call blocked; WhatsApp+UI Issue instead. 10:00 Saturday: outbound allowed. Inbound 23:00: accepted.

---

## L14 — Schedules — §81

Overlap skip: second fire skipped. Missed run >15 min: skip + Issue. Three errors: pause + Issue. Restart: no duplicate fire (idempotency on `scheduled_for`).

---

## L15 — Restore — §82

Isolated directory restore of restic snapshot: projects, conversations, tasks, issues, schedules, decrypted canary credential, artifacts, model registry, config. Fake OAuth: UserActionRequest created. **Critical before launch**, can run against a second folder not a second VPS.

---

## L16 — UI security — §83

Browser: no gateway token, no DB, no provider master, no master.key. Expired/used action links fail.

---

## L17 — Mobile a11y — §84

Phone viewport: health, add context, resolve API-key Issue, approve, reprioritize, open artifact. Keyboard desktop: same. No desktop-only blocker for those six.

---

## L18 — Improvement — §85

Weekly job (or forced run): one candidate recorded, sandbox eval artifact, recommendation, no auto-activate risky.

---

## L19 — Maintenance — §86

Simulate disk 85%, expired cred, missed backup, stuck browser: safe auto-repair where listed; Issues for the rest; audit visible.

---

## L0 — First-run chat and create-project (critical, product)

This is the operator's first real loop (ADR 012):

1. Open Control Center, no project selected.
2. Chat with the global Supervisor: paste documentation, ask Jarvis to remember it.
3. Ask Jarvis to create a project (personal or professional); answer onboarding questions in the thread.
4. New project row exists; no other application projects were pre-seeded.
5. Follow-up in that project's conversation works.

---

## L0b — Happy engineering loop (critical once a project exists)

1. WhatsApp or UI: “In Alpha, the login button is off-center on mobile. Fix and open a PR.”
2. Inbox persisted → project Alpha → task heavy → worktree → harness with an **allowlisted** profile for Alpha (personal profiles unless the project forbids them).
3. Tests, optional reviewer, PR via broker.
4. Short completion + Control Center link.
5. No deploy unless grant/policy.

Professional variant (created in the test, not seeded): project-owned profile only, no consumer/free on source, higher priority.

---

## Phase mapping

| Loop | First green in |
|---|---|
| L1 persist subset (UI only) | Phase 1–2 |
| L1 WhatsApp | Phase 2 |
| L2–L3 | Phase 1 workers + Phase 6 watchdog |
| L4 | Phase 2–3 |
| L0 first-run chat + create project | Phase 3 |
| L0b, L5–L9, L11 | Phase 4 |
| L10 | Phase 2 |
| L12–L13 | Phase 5 |
| L14 | Phase 2 |
| L15 | Phase 0 backup + Phase 6 verify |
| L16–L17 | Phase 3 |
| L18–L19 | Phase 6 |

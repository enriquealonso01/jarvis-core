# Overnight loop — 2026-09-01

Target: `https://jarvis.enriquecodes.com`. Each entry records what changed, what was
verified live, and what is next.

---

## Tick 1 — Supervisor failover rebuilt, Projects & console shell

### Why this first

Enrique's message in the Control Center chat ("figure out why the supervisor keeps
failing") pointed at the highest-impact defect: **9 of the last 12 messages got no
reply at all.** `inbox_events.routing_note` on the live box showed the same line every
time:

```
Supervisor failover exhausted:
  groq/openai/gpt-oss-120b: 429;
  groq/llama-3.3-70b-versatile: 404;
  google_ai/gemini-2.5-flash: 404;
  nvidia/mistralai/mistral-nemotron: 400 / 500 / fetch failed
```

Root cause: `getProviderCandidates()` hardcoded model ids that the providers do not
serve.

- `llama-3.3-70b-versatile` is not in this Groq account's catalog at all.
- `gemini-2.5-flash` **is** listed by Google's `/models` endpoint but the chat endpoint
  answers `404 … no longer available to new users. Please update to gemini-3.6-flash`.
- `mistralai/mistral-nemotron` is listed by NVIDIA but its chat endpoint errors.

So the primary hit its free-tier 429 and **every fallback was a dead id**. Registering a
model from a provider's list is not evidence it can be called.

### Changes — jarvis-core

- `migrations/003_model_routing.sql` — `model_registry` gains `route_order`,
  `auth_profile_id`, `endpoint_url`, `last_checked_at`, `last_error`; deletes the
  known-dead pins so verification reseeds them.
- `src/catalog.ts` rewritten around Plan §35 roles (supervisor, utility,
  senior_engineer, reviewer, stt, voice_tts, vision, embeddings). Every chat candidate is
  now **probed with a real tool-enabled call** before it is written as `approved`.
  Transient failures (429, 5xx, timeout) are stored as `degraded` and stay routable;
  hard failures are `failed` and drop out of routing. Adds `routesForRole()` and
  `markRouteHealth()`.
- `src/supervisor.ts` — failover reads `model_registry` instead of a hardcoded list,
  retries 429 with `Retry-After`-aware backoff, records the provider's **actual error
  body** (a bare status code is what made this hard to diagnose), and updates route
  health as it goes. System prompt now states how Jarvis actually works — WhatsApp is
  OpenClaw + QR pairing on this VPS, **not** a paid Business API — because the Supervisor
  had been telling Enrique to buy Twilio/360dialog. New `conversation.create` tool.
- `src/operations.ts` (new) — `GET /api/operations/summary`: one aggregation for the
  status bar, Command Center cards, and "Needs You".
- `src/index.ts` — richer `/api/projects` (open tasks, issues, threads, last activity);
  `POST /api/conversations` and `PATCH /api/conversations/:id` (new threads, Enrique's
  ask); `/api/models` also returns routes grouped by role; `/api/health` now reports
  routing health from live-probed models, not from "a key exists".
- `src/product.ts` — `/api/projects/:id` returns the full detail payload (tasks,
  conversations, issues, schedules, artifacts, memory, connections, activity) and accepts
  a slug or a uuid.
- Catalog verification moved **off** the startup path. It makes live provider calls; a
  cold NIM endpoint was holding the API from listening for minutes.

### Changes — jarvis-control-center

- `StatusBar` — persistent, sticky: Healthy/Degraded/Incident, current heavy task,
  queue depth, open issues, "Needs you" count, stale-SSE indicator.
- `CommandPalette` — Ctrl/Cmd+K over pages, projects, and threads.
- `Composer` — global "Ask Jarvis" on every page, persist-first, with the
  saved-but-supervisor-failed case surfaced honestly.
- `/projects` — real table (type, repo, open work, issues, threads, last activity) plus
  inline project creation.
- `/projects/detail/?slug=…` — all eleven Plan §40 tabs: Overview, Work, Conversations,
  Activity, Repository, Artifacts, Memory, Connections, Schedules, Issues, Settings.
  "New thread" opens a thread scoped to that project.
- `/conversations` — three-column list | thread | context, thread creation with optional
  project scope, scope filter, autoscroll.
- `/models` — organised **by role** with the failover order and each route's live health
  and last error; "Full registry" view retained.
- Home — Needs You panel, project overview table, recent conversations, supervisor
  routing card, and a **phase tracker** (named phases, no fake percentages).
- Nav gains Projects; mobile bottom nav is Home / Work / Chat / Issues / **More** sheet.
- `app/console.css` — status bar, tabs, palette, composer, needs-you, role routing, and
  a real mobile pass (Enrique's "fix the Phone UI").

### Verified live

| Check | Result |
|---|---|
| `GET /api/health` | `ok:true`, `supervisor_route: healthy` |
| Supervisor round trip | reply in **0.67 s** (was: no reply at all) |
| Supervisor answer quality | now says OpenClaw + QR, no paid API |
| Catalog probe | `gpt-oss-120b ok; qwen3.8-27b ok; gemini-3.6-flash ok; nemotron-3.5-lightning ok; gemini-3.1-flash-lite ok` |
| Supervisor fallback chain | 3 healthy routes across **2 providers** (was 1, with 3 dead fallbacks) |
| `model_registry` | 5 → **16** models, all roles seeded |
| `GET /api/operations/summary` | returns status, queue, needs-you (4 items) |
| `POST /api/conversations` | `201`, thread created |
| `GET /api/projects/:slug` | full tabbed payload |
| All 18 console routes | `200` |
| `scripts/acceptance-runner.py` | **9/9 PASS** |
| API cold start | minutes → ~12 s |

Browser console on the live site shows no JS runtime errors (only the expected 401s
before sign-in). I did not sign in to the browser myself — entering a password into a
form is outside what I do; the API-side checks above cover the same ground, and the
rendered pages are worth an eyeball.

### Enrique's chat asks — status

| Ask | Status |
|---|---|
| Figure out why the Supervisor keeps failing | **Done**, root-caused and fixed |
| Create new threads | **Done** — API + UI, global or in a project |
| Open threads inside projects, go into projects | **Done** — `/projects` + tabbed detail |
| Improve chat UI/UX | **Done** — three-column, context panel, autoscroll |
| Fix the Phone UI | **Done** — mobile pass, More sheet, composer/table/tab reflow |
| Improve overall Control Center UX | In progress — status bar, palette, Needs You landed |
| Composio for connecting any tool | **Next tick** — seed the connection, Issue for the auth step |
| WhatsApp ready to connect tomorrow, no paid service | **Next tick** — OpenClaw prep; QR pairing stays gated on Enrique |

### Next

1. Composio: auth profile + connection row, Connections card, Issue for tomorrow's auth.
2. OpenClaw/WhatsApp: verify the bridge + compose profile are ready so pairing is one QR
   scan; Issue records the gated step.
3. `/work` task detail: activity timeline, checkpoints, tests, PR state, pause/resume.
4. `/queue` grouped by Running / Up Next / Blocked / Waiting / Recovering / Completed.
5. `/issues` durable ticket UI with required action and suppression.

---

## Tick 2 — Issue noise, Queue/Work/Issues UI, Composio, WhatsApp path proven

### Issues were unusable

18 open tickets, 11 of them the same one. `inbox.ts` deduped on
`supervisor.fail.${inboxId}`, so every failed message opened its own ticket for a
single broken route. Dedupe keyed on the id of the thing that failed cannot dedupe
anything.

- `migrations/004_issues_and_composio.sql` — `issues` gains `occurrences` and
  `last_seen_at`; the 11 stale supervisor tickets collapse into one resolved ticket
  carrying the count.
- `src/inbox.ts` — dedupes on the failure *class* (`supervisor.fail.routing`), bumps
  `occurrences`, stores the provider's real error as evidence, and **auto-resolves on
  the next successful turn** — a working turn is the evidence the fault cleared.

Open issues: **18 → 8**, and all eight are genuine gated setup items with a concrete
`required_action`. System status went `degraded` → `healthy`.

### The console was about to drown in heartbeats

The 5-minute `health` schedule books a task per tick — 288/day. `/api/tasks` returns
100 rows, so within hours the task list would have been nothing but `health`, hiding
every real task. Routine background-schedule tasks are now rolled up: `/api/queue`
returns a `routine` summary and `/api/tasks` excludes them (`?routine=1` to include).
Default task view: **71 rows → 1 real task**, with a "health · 70 runs in 24h" card.

### WhatsApp: the bridge would not have loaded

Enrique asked for WhatsApp ready to connect today. `packages/openclaw-jarvis-bridge/index.js`
was a `.js` file containing TypeScript annotations (`signBody(secret: string, …)`).
Node cannot parse that, so the plugin would have failed to load and OpenClaw would have
answered his DMs with its own default agent — the exact thing the bridge exists to
prevent. Rewritten as valid JavaScript. `deploy/compose.yaml` now gives the OpenClaw
service `env_file` (for `INTERNAL_HMAC`) and `JARVIS_INGEST_URL=http://api:8080/…` —
the previous default pointed at `127.0.0.1:8080`, which inside that container is nothing.

Then a second defect surfaced while proving the path: `/internal/inbox/ingest` inserted
an inbox row **and** `ingestUserMessage` inserted another, so every WhatsApp message
would appear twice in the Inbox with the adapter's row stuck on `pending` forever.
`ingestUserMessage` now accepts an existing `inboxId` and reuses it.

**Proven end to end on the live box:** a signed bridge call → HMAC verified → one
`channel=whatsapp` inbox row → Supervisor replied. Pairing itself stays gated on
Enrique scanning the QR.

### Changes — Control Center

- `/issues` — durable ticket UI: severity/status/owner, occurrence count, required
  action called out, evidence, event trail, notes, full status transitions, suppression
  with a reason.
- `/queue` — grouped Running / Up Next / Blocked / Waiting for User / Waiting for
  Approval / Waiting for Provider / Recovering / Paused / Recently Completed, each with
  what that group actually means, inline reprioritise and pause/resume/cancel, plus the
  System heartbeat rollup.
- `/work` — task detail: phase tracker (named phases, no percentages), objective,
  model/harness/auth profile, branch, head SHA, worktree, lease and heartbeat, grants,
  approvals with SHA binding, attempts, transition timeline, checkpoints, and issues
  raised by the task.
- Composio seeded as an auth profile + connection with a live credential test, so it
  shows on Connections and in Needs You before Enrique authorises it. Supervisor gained
  a `connection.list` tool so it describes what is actually stored rather than guessing.

### I broke the live site, then fixed it

The deploy swapped `/opt/jarvis/control-center` with `mv`. Caddy bind-mounts that path,
so the swap left the container serving a directory that the next deploy deleted —
every route 404'd. Recreated Caddy to restore it, then wrote
`scripts/deploy-control-center.sh`, which syncs *contents* in place and never replaces
the mounted directory. All 18 routes verified 200 afterwards.

### Verified live

| Check | Result |
|---|---|
| `/api/health` | `ok:true`, routing healthy |
| `/api/operations/summary` | `healthy`, 5 Needs You, 8 open issues |
| Issue status transition + note + trail | works, verified and reverted |
| Queue grouping + heartbeat rollup | `health: 70 runs/24h`, 1 real task |
| Bridge → HMAC → inbox → reply | one `whatsapp` row, `processed`, Jarvis replied |
| All 18 console routes | `200` |
| `scripts/acceptance-runner.py` | **9/9 PASS** |

### Next

1. `/connections` provider cards with test/reconnect and per-project integrations.
2. `/approvals` SHA-bound approve/reject; `/artifacts` retention and preview.
3. `/schedules` next/last run; `/improvement` and `/maintenance` operational pages.
4. Notification center in the shell, fed by `notifications_outbox`.
5. `/settings` audit log view.

---

## Tick 3 — Connections, Approvals, Schedules, Artifacts, Inbox, Settings, notification center

Every remaining page was written against fields the API does not return. Three of them
were not just cosmetic.

### The Approve button rejected the action

`/approvals` sent `{ decision: "approve" }`. The handler read
`Boolean(body.approved)` — `undefined` for that payload — so it evaluated to `false`
and wrote `state = 'rejected'`. **Clicking "Approve Action" silently rejected it**, with
no error and no way to tell from the UI. The handler now accepts either shape, refuses a
non-pending approval with 409 instead of pretending, and writes an `approval.approve` /
`approval.reject` record to the audit log. Verified live: created a pending `pr.merge`
bound to a SHA, approved it with the console's own payload, confirmed `approved` and the
audit entry.

### Pages reading fields that were never sent

- `/connections` read `c.name` and `c.provider`; the API returns `display_name` and
  `kind`, so **every card title rendered blank**.
- `/settings` read `created_at` on audit events; the column is `at`, so **every
  timestamp was "Invalid Date"**.
- `/artifacts` read `permanent` and `retain_until`, which the query never selected.
- `/improvement` and `/maintenance` filtered tasks and schedules by the substring
  "improvement" / "eval". The real schedules are `weekly-research`, `health`,
  `daily-retention`, `weekly-prune`, `monthly-restore-test`, so **both pages matched
  nothing and rendered empty**. They now read their own system project.

### Changes — jarvis-core

- `src/cron.ts` — `cronNextRun()`: forward scan bounded at 62 days, so a monthly cron
  resolves and a malformed one returns null rather than spinning.
- `/api/schedules` — last run, next run (computed in each schedule's own timezone), 7-day
  run count, and the last run's task state. New `/api/schedules/:id/runs` for history.
- `/api/artifacts` — retention class, `retain_until`, `permanent`, sha256, project.
- `/api/audit` — project join, and `at` aliased to `created_at` so every timestamp in the
  API has one name.
- `/api/approvals` — target, environment, `resource_version`, project and task joins,
  pending first.
- `/api/projects/:id` — routine heartbeat tasks rolled up the same way the queue does it.
  Maintenance's task list went from **50 identical `health` rows to 1 real task**.

### Changes — Control Center

- `/connections` — provider cards with what each connection is *for*, credential state,
  fingerprint, last test, inline key add/rotate, and test-now. Host subscription logins
  say plainly that there is nothing to paste. System and project-scoped are separated.
- `/approvals` — pending decisions with the target, environment, and the commit the grant
  is bound to, an explicit note that approving authorises that commit only, plus decision
  history.
- `/schedules` — cron, timezone, last run with its outcome, computed next run, 7-day
  count, pause/resume, and expandable run history.
- `/artifacts` — retention classes explained, size, scan state, deletion countdown, and a
  detail panel. Metadata only; bytes stay on the server.
- `/inbox` — every captured event with channel, sender, capture and processing state, the
  failure reason when there is one, and reroute-to-project.
- `/settings` — instance facts, standing policy in plain words, and a filterable audit log.
- Notification center in the header: "Needs you" and the outbox in one panel, with an
  unread count kept in `localStorage` (wrapped so a private window still works).

### Verified live

| Check | Result |
|---|---|
| Approval create → approve → audit | `approved`, audit row written |
| Next-run computation | `weekly-research` → Mon 10:00 America/New_York = 14:00 UTC |
| `/api/schedules` | 5 schedules, `health` 73 runs/7d, last `succeeded` |
| `/api/connections` | 15 fields incl. `display_name`, `fingerprint`, `project_slug` |
| `/api/audit` | project join + `created_at` alias |
| Maintenance project tasks | 50 → **1** after the rollup |
| All 18 console routes | `200` |
| `scripts/acceptance-runner.py` | **9/9 PASS** |

### Next

1. Re-read `FULL_LOOPS.md` and `PHASE_CHECKLIST.md`; enumerate remaining ungated gaps.
2. `/actions/[id]` secure credential/OAuth/MCP flow against the real action-request shape.
3. Engineering harness spawn (Phase 4) where not gated.
4. SSE-driven live updates for the status bar rather than a 20s poll.

---

## Tick 4 — Real state machine, and acceptance that actually tests the loops

Re-read `FULL_LOOPS.md`, `PHASE_CHECKLIST.md`, and `STATE_MACHINES.md` and compared them
against what the box does. The suite was 9 shallow checks; nine of the critical loops had
no coverage at all, and two documented contracts were being violated outright.

### Contracts the worker was breaking

`STATE_MACHINES.md`: *"Every task/issue/inbox change writes a transition row where
specified. Watchdog sets `stalled` then `recovering`. Worker never self-sets `succeeded`
without a final checkpoint."*

- **No task ever wrote a `task_transitions` row.** The Work view's Activity timeline was
  permanently empty, and a recovery left no trace of what happened.
- The watchdog went `running → recovering` directly, **skipping `stalled`**.
- The worker set `succeeded` with **no checkpoint**, so L2's "resume from the latest
  checkpoint" had nothing to resume from.

Fixed with `transitionTask()` and `writeCheckpoint()` in `src/jobs.ts`, used by the
worker, the watchdog, and the console's pause/resume/cancel. Those three endpoints now
also return **409 instead of silently doing nothing** when the task is not in a state
that allows the action.

The trail this produces, read back from the live box:

```
-          → running     acceptance probe created      acceptance
running    → stalled     heartbeat missed for 90s      watchdog
stalled    → recovering  watchdog recovery             watchdog
recovering → queued      requeued from checkpoint      watchdog
queued     → preparing   claimed from queue            system-1
preparing  → running     system job                    worker
running    → succeeded   system job completed          worker
```

### §80.1 was documented but not enforced

Nothing stopped a project-owned auth profile from serving the Supervisor. `routesForRole`
now excludes any profile bound to a project-scoped connection for the `supervisor` and
`utility` roles, and writes a `security.isolation` audit event when it refuses one —
**before** any HTTP request reaches the provider.

Exhausting the Supervisor pool now raises `provider.degraded` (plan §74) with an explicit
note that metered spend was **not** enabled, and a healthy turn resolves it.

### Acceptance suite: 9 → 15 tests

New, and each one drives real state rather than asserting a 200:

| Loop | What it now proves |
|---|---|
| **L2** | A queued task survives and keeps its queue position |
| **L3** | Stall → watchdog → `stalled`/`recovering`/`queued` → reclaimed → succeeded, with a `worker.crash` Issue |
| **L4** | The Supervisor has ≥2 healthy routes across **≥2 providers** and answers live |
| **L11** | No project-owned profile has leaked into a system role |
| **L14b** | Every active schedule resolves a real next run |
| **L17** | All six mobile-critical journeys are reachable |

L4's bar is deliberately "two providers, not two models" — a single-provider fallback
chain is what took the Supervisor down in the first place.

The two hooks the suite needs (`/api/acceptance/task`, `/api/acceptance/stall`) require an
operator session and origin, only accept tasks titled `acceptance …`, and only ever age a
probe task's own heartbeat. They were first written under `/internal/*` and failed —
correctly: Caddy does not proxy `/internal`, which is the HMAC-only bridge path. Moving
them to `/api` was the right fix rather than opening that path.

### Live updates

The status bar polled every 20s. It now refreshes on the SSE events that change what it
shows (`task.updated`, `queue.updated`, `issue.updated`, `approval.updated`, `health`),
coalescing bursts into one request, with a 60s interval left only as a backstop for when
the stream is down — which is also when the stale banner is up.

### Result

**15/15 PASS**, including six critical loops that had never been exercised.

```
L0 L1 L2 L3 L4 L8 L11 L13 L14 L14b L16 L17 + AUTH CONN MODELS
```

L4 reported `healthy_routes=3 across 2 providers` on the final run and 4 across 3 on the
previous one — NVIDIA's endpoint flips to degraded under load. That variance is real and
the suite reports it rather than smoothing it over.

### Still not covered, and why

| Loop | Status |
|---|---|
| L5 connection repair | Needs a deliberately broken GitHub credential — destructive to a working connection |
| L6 two-repo isolation | Creates two real private repos on Enrique's GitHub; always-confirm, so it needs his approval |
| L7 grant merge/deploy | Same — needs a real repo and a real PR |
| L9 cross-project probe | Needs two real project worktrees with credentials |
| L12 audio GC | Phase 5, no audio pipeline yet |
| L15 restore | Needs a restic restore drill into an isolated directory |
| L0b happy engineering loop | Blocked on the host CLI logins (gated) |

None of these are blocked on code I can write unattended; they need either Enrique's
approval for an outward-facing action or a gated login.

### Next

1. L15 restore drill into an isolated directory — fully local, nothing outward-facing.
2. `/actions/[id]` against the real `user_action_requests` shape (L5's user-facing half).
3. Cross-project isolation assertions that do not need real repos (filesystem + connection
   name probes).

---

## Tick 5 — The backups did not contain the database

This is the most serious defect found so far, and it was invisible by design.

### What was wrong

`scripts/jarvis-backup.sh` dumped Postgres to `/var/lib/jarvis/quarantine/pg-<stamp>.dump`,
passed that path to restic, and then — on the next line — excluded it:

```
restic backup --one-file-system \
  /var/lib/jarvis /etc/jarvis ${DUMP:+"${DUMP}"} \
  --exclude /var/lib/jarvis/quarantine     # <- deletes the dump from the backup
```

The Postgres data directory is a **named Docker volume**, so a file-level backup of
`/var/lib/jarvis` contains none of it. That dump was the only copy of the database, and
the exclude threw it away every single run.

Evidence from the live repository before the fix:

```
2026-08-31T22:17:17   files= 6   bytes= 2787
2026-09-01T02:15:01   files= 6   bytes= 2866
```

**Two snapshots, six files, 2.8 KB.** Empty directories and `master.key`. Every project,
conversation, task, issue, memory item, credential, and the model registry: not backed up.
Had the box been lost, all of it was gone.

And nothing would have caught it. The monthly `jarvis-restore-test` only ran
`restic snapshots` and asserted the list was non-empty — it passed happily against
database-free backups. A backup nobody has restored is not a backup.

### The fix

- Dumps now go to `/var/lib/jarvis/db-backup`, inside the backup set, never excluded.
- The script **fails closed**: refuses a dump under 10 KB, refuses to run at all if the
  Postgres container is down, and after writing the snapshot re-reads it by id and
  confirms the dump is really in there before pruning anything. Retries that check,
  because restic's index can lag a moment behind the write.
- Local dumps are trimmed to the newest three; restic holds the history.

First verified backup: **120,208-byte dump, present in snapshot `01e83dcd`.**

### `scripts/restore-drill.sh` — L15 for real

Listing snapshots is not a restore test. The new drill:

1. Restores the latest snapshot into an isolated `restore-drill/<stamp>` directory.
2. Loads the dump into a **throwaway** `jarvis_restore_drill` database — nothing live is
   touched.
3. Asserts row counts for projects, conversations, tasks, issues, schedules,
   model_registry, credentials, dek_keys, config_versions, audit_events.
4. **Decrypts a canary credential with the restored master key** — the one check that
   proves the encrypted store survives a restore. Compares fingerprints; the plaintext is
   never printed.
5. Drops the database, deletes the restore directory, fails closed.

Live result:

```
projects 15 · conversations 2 · tasks 81 · issues 20 · schedules 5
model_registry 16 · credentials 6 · dek_keys 6 · audit_events 8
canary credential decrypted: {"decrypted":true,"fields":"api_key","fingerprint":"groq:…55zB"}
restore-drill ok
```

Two bugs surfaced while getting there and were fixed: the drill script needed LF endings
(it was uploaded with CRLF and `env` refused `bash\r`), and Postgres `encode(...,'base64')`
line-wraps at 76 characters, which corrupted the canary through `psql`. Hex instead.

### Visible where it matters

The drill reports its outcome over the HMAC-only internal path
(`/internal/maintenance/restore-drill`). A pass writes `backup.restore_drill.pass` to the
audit log and marks `backup_b2` healthy; a failure opens a **critical** Issue that says
plainly not to trust the backups until it passes. Cron now runs the real drill monthly
instead of the snapshot-listing stub, which has been retired.

### Acceptance: 15 → 16

`L15 — Backup Restore Drill` asserts the most recent drill passed, the canary decrypted,
**and** the dump was over 10 KB — because "passed with no database in it" is precisely the
failure that was live until today.

```
[PASS] L15: last=backup.restore_drill.pass, dump_bytes=120208, canary_decrypted=True
```

**16/16 PASS.**

### Next

1. `/actions/[id]` against the real `user_action_requests` shape (L5's user-facing half).
2. Cross-project isolation probes that need no real repos (L9 partial).
3. Re-read `ERROR_TAXONOMY.md` and `CREDENTIAL_BROKER.md` for remaining ungated gaps.

---

## Tick 6 — Action requests: the "Needs You" loop had no other end

### The flow did not exist

`user_action_requests` is the table the plan uses for "user submits new PAT on the action
page" (L5). Grepping the whole of `src/`: **nothing ever inserted a row.** The table was
read in two places and written in none. Every setup blocker was an Issue with a sentence
of `required_action` text and nowhere to act on it.

And the page that was supposed to serve them could not have worked anyway. It read
`request.title` and `request.state`; the endpoint returned neither. `state` being
`undefined` meant `request.state === "pending"` was always false, so **the form never
rendered** — a fresh pending request displayed "✓ This action request has been consumed
and resolved." Same class of defect as the Approve button in tick 3: a page written
against a shape the API does not return.

### `src/actions.ts`

- `ensureActionRequest()` — idempotent per issue, mints a **one-time token** (only the
  hash is stored, 7-day expiry) so a link sent over WhatsApp works without a session and
  stops working once used.
- `GET /api/action-requests` / `GET /api/action-requests/:id` — a **derived** state
  (`pending` / `consumed` / `expired`) rather than a stored one that can drift, joined to
  its Issue. A valid token stands in for a session; a bad one 404s rather than confirming
  the id exists.
- `POST /api/action-requests/:id/submit` — stores the credential through the broker,
  marks the request consumed, **resolves the linked Issue, and requeues the tasks that
  were parked on it** with a transition recorded for each. Returns 409 for an already
  used or expired link.
- `blockers.ts` now attaches an action request to every open setup blocker, with wording
  that says what the thing actually is — the host logins state plainly that there is
  nothing to paste because they are subscription logins completed on the VPS.

Seven action requests now exist, one per real blocker, each reachable from "Needs You".

### A duplicate I made and removed

Adding action requests made every blocker appear **twice** in Needs You — once as the
request, once as the bare "profile has no credential" line — so the panel read 12 when
there were 7 things to do. The action request wins for a profile it covers, and requests
whose Issue is already resolved drop out. Back to **7, one per blocker**, each with a
human title and a direct link.

### `/actions` rewritten

Real states, per-kind handling (paste a key, paste a refresh token, or "I have done this
on the VPS" for the ones completed off-console), an expired-link message that says how to
get a fresh one, and a list of everything outstanding when opened without an id. The key
field says plainly that the value goes straight to the server, is never logged, and only
its fingerprint comes back.

### Acceptance: 16 → 17

`L5 — Action Request Flow` drives the whole path on the live box: create → load pending →
submit → confirm consumed → **replay the used link and require 409** → confirm an unknown
id 404s. That replay assertion is the L16 clause "expired/used action links fail", which
until now nothing checked.

```
[PASS] L5: pending=True, submitted=True, consumed=True, replay_blocked=True, unknown_404=True
```

**17/17 PASS.**

### On the restore-drill cadence

I flagged moving the drill from monthly to daily and left it monthly, because that is what
the frozen plan specifies and the cadence is Enrique's call. The cheaper half of the
protection is already daily and unconditional: every backup now verifies its own snapshot
contains the dump and refuses to prune otherwise, so the tick-5 failure mode cannot
recur silently between drills.

### Next

1. Cross-project isolation probes needing no real repos (L9 partial).
2. `ERROR_TAXONOMY.md` pass — error classes that exist in the doc but not in code.
3. Notification brevity (L10) — trivial actions should not page.

---

## Tick 7 — Nothing ever wrote to the notification outbox

### The gap

`notifications_outbox` was drained by the worker every loop and **written by
nothing**. Plan §17 (WhatsApp notification policy) and the entire `notify` column of
`ERROR_TAXONOMY.md` — `none | ui_only | whatsapp_degraded | whatsapp_blocker` — existed
only as documentation. Every Issue was equally silent, so a critical blocker and a routine
retry were indistinguishable from outside the console.

The taxonomy's retry/limit/backoff columns were unimplemented too: the outbox retried on a
flat 15-minute interval regardless of class, and `min(600, 2^attempt)` appeared nowhere.

### `src/notify.ts`

The taxonomy as code — all 33 error classes with their severity, retryability, limit, and
notify level — plus:

- `raiseIssue()` — **the** way to open an Issue. Dedupes on the class key, bumps the
  occurrence count, and notifies at whatever level the taxonomy says for that category,
  instead of every call site inventing both. A repeat of an already-open Issue is a count,
  **not another page**.
- `enqueueNotification()` — §17.5 transactional outbox with an idempotency key.
  `ui_only` stays in the console; the WhatsApp levels also write a `ui` row so the
  notification center shows what the phone would have said. `none` returns null and
  writes nothing at all.
- `backoffSeconds()` — `min(600, 2^attempt)` with 0–20% jitter, now used by the outbox
  drain instead of the flat interval.
- `notifyTaskComplete()` — §17.1/§17.2: trivial captures and system-lane work produce no
  completion message.

Wired into the watchdog, the harness park, the Supervisor failure path, the setup
blockers, and the restore-drill failure — replacing five hand-rolled `INSERT INTO issues`
blocks that each had their own dedupe idea.

### Verified live

The outbox went from empty to **14 rows: 7 blockers × {ui, whatsapp}**. The `ui` rows
drain to `sent` immediately; the WhatsApp rows sit `pending` because no transport is
paired yet — correct, and they now back off on the taxonomy curve rather than retrying
every 15 minutes forever.

Two properties that matter more than the row count:

| Check | Result |
|---|---|
| Restart the API — does the outbox grow? | 14 → **14**. Idempotency keys hold. |
| Trivial "remember this" turn — does it page? | 14 → **14**. §17.1 silence holds. |

### Acceptance: 17 → 18

`L10 — Notification Brevity` asserts a trivial capture adds nothing to the outbox, no
notification id repeats, and each distinct blocker fans out to **at most** ui + whatsapp.

```
[PASS] L10: trivial_silent=True, outbox=15, distinct_blockers=7, max_per_blocker=2
```

**18/18 PASS.**

### Next

1. L9 cross-project isolation probes (filesystem + connection-name, no real repos needed).
2. `WORKERS.md` pass — specified but unimplemented, ungated only.
3. Remaining §39–§43 UI gaps.

---

## Tick 8 — Audited every table for the pattern, and enforced the isolation checks

Three ticks running had found the same shape: a table specified in `DATA_MODEL.md`, read
by the API, and **written by nothing**. Empty lists render as "nothing to show", so each
one looked healthy from the console. Rather than keep tripping over them, I checked all 36
tables against their writers.

| Table | Finding |
|---|---|
| `auth_profile_allowlists` | **Referenced nowhere in code at all** |
| `connection_project_allowlist` | **Referenced nowhere in code at all** |
| `health_incidents` | Referenced nowhere at all |
| `config_versions` | Read by `/api/config-versions`, never written |
| `task_attempts` | Read by the Work view's Attempts table, never written |
| `artifacts`, `benchmarks`, `knowledge_chunks`, `task_grants` | Legitimately empty — Phase 4/5/6 features |
| `channel_allowlist`, `routing_overrides` | Legitimately empty — gated or only on use |

The first two are the serious ones. They are the "project allowlist" and "role allowlist"
of `CREDENTIAL_BROKER.md`'s check order — **the isolation controls themselves** — and no
code path consulted them. Nothing was enforcing L9 or the allowlist half of §80.1.

### `src/isolation.ts`

The broker check order as code, failing closed:

- `checkConnectionAccess()` — a project-scoped connection belongs to exactly one project;
  asking for another project's by name is the L9 probe. The GitHub **admin** profile is
  broker-only and can never be selected by a project. A shared connection with an explicit
  allowlist requires membership — an empty allowlist means *not shared yet*, not *shared
  with everyone*.
- `checkProfileAccess()` — confidentiality eligibility, then per-project and per-role
  allowlists when the profile has any.
- `recordDenial()` — every denial audited; `security.isolation` also raises an Issue
  through the taxonomy, so cross-project probing pages rather than sitting in a log.
- `POST /api/broker/resolve` — one place capabilities resolve a connection, so the rules
  are enforced once instead of at each future call site. It returns *whether* the caller
  may use a credential and which profile the broker would unwrap; never the secret.

Verified live:

```
groq from jarvis-improvement            → 200 allowed
github_personal_admin from a project    → 403 security.isolation (broker-only)
some-other-projects-secret              → 403 security.broker_deny
both denials present in the audit trail
```

### Health that checks something

`healthCheck()` did `SELECT 1` and a RAM check. It now checks disk (pages at 85% per the
taxonomy), supervisor routing, restore-drill staleness, and tasks stuck in recovery — and
opens a `health_incidents` row when a service goes bad, closing it on recovery. "Healthy"
now has history behind it, and a flapping service is distinguishable from one that never
broke.

### Also closed

- `task_attempts` written per attempt, **before** the work runs so an attempt that kills
  the process is still visible. The Work view's Attempts table has data.
- `config_versions` written on every schedule edit, with before/after. Verified by pausing
  and resuming `weekly-prune`: two versions recorded, schedule left active.
- `/api/audit` returned `{audit: …}` while `/settings` read `events` — **the audit log
  page rendered empty**. Now returns `events` (with `audit` kept as an alias).

### Acceptance: 18 → 20

```
[PASS] L9:  admin_denied=True, unknown_denied=True, legit_allowed=True, audited=True
[PASS] L19: open=0, recorded=0, postgres_up=True
```

L9 asserts the denials *and* that a legitimate connection still resolves — a check that
denies everything is not an isolation control, it is an outage.

**20/20 PASS.**

### Next

1. `SUPERVISOR.md` and `WORKERS.md` passes — specified behaviour still missing, ungated only.
2. Surface health incidents and config versions in `/maintenance` and `/settings`.
3. Remaining §39–§43 UI gaps.

---

## Tick 9 — SUPERVISOR.md pass, and a control that was missing entirely

### The tool catalog was one short

`SUPERVISOR.md` calls its tool list "exhaustive for V1". `connection.request` — open a
UserActionRequest for a missing key — was not implemented, so when the Supervisor hit a
missing credential its only options were to open a bare Issue or tell Enrique to go edit
something. It now opens the Issue *and* the action page he can complete, and the prompt
tells it to prefer that over instructions.

### Project threads could not see their own project

The prompt loaded `WHERE project_id IS NULL` — global memory only. A conversation scoped
to a project got **none of that project's memory, and none of its facts**: type,
confidentiality, production status, repository, spend policy, or its stored instructions
from `config_versions`. That is why project answers read like generic advice. All of it is
in the prompt now, project memory first.

### SSE fired on a path the console does not use

`conversation.message` was broadcast from `/api/inbox` only. The console posts to
`/api/conversations/:id/messages`, so the event the spec requires after every assistant
message never fired for the actual chat.

### ADR 005 — the redaction control did not exist

ADR 005 says the Supervisor runs on free/consumer accounts and must never receive
repository contents, logs, or confidential bodies. None of it was implemented:

- A **confidential or restricted** project's message went to the provider in full.
- Code or a stack trace pasted into **global chat** — no project assigned — went straight
  to Groq. The ADR is explicit: *"Fail closed — do not send suspected confidential bodies
  to a free/consumer model."*

`src/redaction.ts` implements the heuristic (fences, tracebacks, `path:line`, patches,
private-key headers, top-level declarations) and the metadata-only payload: project,
confidentiality, channel, sender, byte size, and a 120-character summary — replaced with
`[redacted confidential body…]` when the heuristic fires. Confidential threads also drop
the recent-history window, which would have leaked the body anyway.

Unrouted suspected-confidential input is now **held**: stored, not sent, with a routing
Issue and a reply that says plainly what happened and how to proceed. Verified live:

```
"Reply with the single word OK."   → OK
a Python traceback with a token    → held, routing Issue opened, nothing sent
```

### A bug I introduced, found, and fixed in the same tick

After deploying, a normal global message failed with
`issues_severity_check` violated. Cause: `issue.create` passed the **model's**
`severity` string straight into a CHECK constraint — so the Supervisor could abort its own
turn by saying `urgent`. It had been latent since before this loop; my new prompt made the
model reach for `issue.create` more often and exposed it. Severity is now coerced to the
four legal values and the tool routes through `raiseIssue`, so it dedupes and notifies like
everything else. Verified by asking for severity `urgent`: stored as `medium`, turn
completed.

### Acceptance: 20 → 21

```
[PASS] ADR005: normal_answered=True, code_held=True, routing_issue=True
```

The test asserts prose still gets a real answer as well as the hold — a filter that blocks
everything is an outage, not a control.

**21/21 PASS.**

### A note on the trade-off

This makes global chat refuse pasted code until it is routed to a project. That is what
ADR 005 specifies and I have implemented it as written, but it is the first change in this
loop that can make Jarvis *less* convenient. The recovery is one click on the Inbox page,
and project threads are unaffected. If it proves annoying in practice, the heuristic is one
function and the threshold is Enrique's call.

### Next

1. `WORKERS.md` pass — specified but unimplemented, ungated only.
2. Surface `health_incidents` and `config_versions` in `/maintenance` and `/settings`.
3. `TEMPLATES.md` onboarding fields — professional projects must ask the required questions.

---

## Tick 10 — WORKERS.md pass: cancel did not cancel, and logs were being treated as resume points

### Progress events were written into `task_checkpoints`

`/internal/workers/events` inserted each tool/test/git/review event into
`task_checkpoints`. That is the table the watchdog resumes from — so **a tool log line and
a durable resume point were the same thing**, and "requeued from latest checkpoint" could
mean "requeued from a log line that says `pytest`".

`migrations/005_worker_protocol.sql` adds `task_events`, moves the misfiled rows across,
and deletes them from `task_checkpoints`. Verified after deploy: a posted event lands as
`events=1, checkpoints=0`.

### Cancel only rewrote a row

`WORKERS.md`: *"`tasks.cancel_requested_at` set by API. Worker checks each heartbeat; then
`cancelled`."* Neither half existed — the heartbeat returned a bare `{ok:true}` and
`runSystemTask` never looked at the flag, so a cancelled task carried on to `succeeded`.

The heartbeat now returns `cancel_requested`, and the worker checks it before starting.
Verified live: cancel → next heartbeat returns `{"ok":true,"cancel_requested":true}`.

### The heartbeat threw away everything it was sent

The documented body carries `phase`, `cpu_busy`, `last_tool`, `progress_note`; the handler
read `task_id` and `worker_id` and dropped the rest. Those are now stored on the task and
shown live in the Work view — real status, still no invented percentage.

### ADR 007 starvation cap

`claimTask` ordered purely by priority then age, so a Normal personal task could be jumped
by professional High work forever. The cap is now in the claim query: a Normal-or-higher
personal task queued 30 minutes goes next. Critical is never subject to it; Background
never benefits.

### Surfaced in the console

- **Work** — live phase / last tool / progress note, and a **Progress** feed of the
  worker's tool, test, git, and review events, separate from Checkpoints.
- **Maintenance** — service health history from `health_incidents`, so a flapping service
  is distinguishable from one that never broke.
- **Settings** — configuration history from `config_versions`, with the before/after of
  each schedule or policy change.

Those three tables were written for the first time in tick 8; now they are visible.

### Acceptance: 21 → 22

`WORKERS` asserts cancel moves the task **and** leaves a transition, that the detail
payload separates events from checkpoints, that no checkpoint is a progress event in
disguise, and that cancelling a finished task returns 409 instead of pretending.

```
[PASS] WORKERS: cancelled=True, flag=True, trail=True, events_split=True, replay_409=True
```

**22/22 PASS.**

### Next

1. `TEMPLATES.md` — professional onboarding must ask its required questions.
2. Sweep ADRs 001–014 for other controls specified but absent (ADR 005 was one).
3. Remaining §39–§43 UI gaps.

---

## Tick 11 — A model-supplied string was building filesystem paths

### Path traversal in project creation

`project.onboarding_finalize` took the slug the **model** put in the onboarding session
and used it directly:

```ts
await fs.mkdir(`/var/lib/jarvis/worktrees/${a.slug}`, { recursive: true, mode: 0o750 });
```

`POST /api/projects` did the same with the request body. Nothing validated the slug — the
column is `text NOT NULL UNIQUE` with no format rule — so `../../../tmp/pwned` was a legal
project slug, and `mkdir -p` would happily create directories outside the jail. Isolation
is the point of that directory layout, so a slug that escapes it undoes the whole scheme.

Fixed in three layers:

1. `validSlug()` in `src/policy.ts` — `^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$`, explicit `..`
   rejection. Applied at `onboarding_set`, at `onboarding_finalize` (answers can predate
   the rule), and at `POST /api/projects`.
2. `path.resolve()` + a `startsWith(root + sep)` check before every `mkdir`, so the call
   cannot escape even if the pattern is ever loosened.
3. `migrations/006_project_slug_guard.sql` — a CHECK constraint on the column, so a future
   call site cannot reintroduce it. Verified no existing slug violates it before adding.

Verified live: `../../../tmp/pwned` → 400, no `/tmp/pwned` on disk, legitimate slugs still
create normally.

### The enum crash, again

`a.confidentiality || "normal"` went straight into a CHECK constraint — the same shape as
the `issue.create` severity crash in tick 9. A model answering "high" or a client posting
`top-secret` aborted the request with a constraint violation instead of a 400. Both paths
now validate `project_type`, `confidentiality`, and `production_status` against the allowed
sets before insert.

`onboarding_set` also accepted **any** field name and wrote it into the answers blob. It
now takes only the fields in `TEMPLATES.md` and validates each value by type.

### TEMPLATES.md professional questions

The doc lists questions that *must* be asked for a professional project. `finalize` created
one with none of them answered, defaulting silently. It now refuses until
`confidentiality`, `production_status`, `customer_facing` and `metered_spend_allowed` are
answered, and the prompt tells the Supervisor to ask. `production_status` is also persisted
now — it was being dropped on the floor.

Metered spend gets one extra guard: `metered_spend_allowed` only takes effect with a
ceiling set, so "yes" alone cannot switch on pay-as-you-go.

### Acceptance: 22 → 23

`VALIDATION` tries six bad slugs including traversal, a bad confidentiality, and a bad
project type — then creates a legitimate project to prove the guard is not just an outage.

```
[PASS] VALIDATION: traversal_blocked=True, enum_400=True, type_400=True, legit_created=True
```

**23/23 PASS.** Probe projects created by the suite are archived afterwards.

### Next

1. Sweep ADRs 001–014 for other specified-but-absent controls.
2. `API_AND_EVENTS.md` pass.
3. Remaining §39–§43 UI gaps.

---

## Tick 12 — ADR sweep: the one public endpoint had no authentication

I read ADRs 001–014 and checked each stated control against the code rather than assuming
the docs described what was built. That found the most exposed defect so far.

### `/webhooks/telnyx` accepted anything from anyone

ADR 009 lists it as public *"with Telnyx signature verification (and replay window)"*.
There was no verification of any kind. The handler read the body and wrote straight into
`inbox_events` — so anyone on the internet could inject events into Jarvis's Inbox and grow
the database without limit. It is the only endpoint besides the console reachable from
outside.

`src/telnyx.ts` verifies the Ed25519 signature over `timestamp|rawBody` against
`TELNYX_PUBLIC_KEY`, with a 300-second replay window, and **fails closed**: with no key
configured — which is today, since Telnyx is gated — every call is refused rather than
trusted. Each rejection raises a deduped Issue naming the reason.

Verified from the public internet:

```
unsigned      → 503 telnyx_unverified
bogus sig     → 503 telnyx_unverified
inbox_events written in the last 2 minutes: 0
```

Closing the endpoint would have hidden the quiet-hours policy the old L13 test exercised
through it, so `GET /api/operations/quiet-hours` now exposes that policy directly, and L13
asserts the **fail-closed** behaviour instead of the permissive 200 it used to accept. A
test that only passes while an endpoint is open is not worth keeping.

### ADR 004 — action link TTL was 84× too long

The ADR (and `TEMPLATES.md`) specify a **2-hour** TTL on the one-time token, because that
link travels over WhatsApp. I had used 7 days in tick 6 — a standing key to a credential
page sitting in a chat log. Now 2 hours by default.

Setup blockers are the exception and are explicit about it: they live in the console behind
a session rather than being mailed out, so a 2-hour token would only mean re-minting on
every visit. They get 30 days, stated in the call rather than inherited by accident.

The ADR also says *"used token replay → 409, Issue category `security` if repeated"*. The
409 was there; the Issue was not. Replays are now recorded, and the third within an hour
raises a security Issue that says to rotate the credential the link pointed at.

### Checked and already correct

- **ADR 004 sessions** — 30-day idle, 90-day absolute, hashed token, HttpOnly/Secure/Lax.
- **ADR 008 secret storage** — envelope encryption, `master.key` 0440 root:jarvis, restore
  test decrypts a canary (tick 5).
- **ADR 009 network** — `ufw` default deny with only 22/80/443; Postgres and the API bound
  to `127.0.0.1`; OpenClaw not exposed.
- **ADR 003 GitHub two-credential model** — Phase 4, gated on repo creation.

### Acceptance: 23/23

L13 rewritten; the count is unchanged because the new assertions replaced the old ones
rather than adding a row.

```
[PASS] L13: unsigned_refused=True (status=503), quiet_hours=True
```

### Next

1. `API_AND_EVENTS.md` pass.
2. Remaining §39–§43 UI gaps.
3. ADRs 001, 002, 006, 010–014 detail pass (this tick covered 003, 004, 005, 007, 008, 009).

---

## Tick 13 — API_AND_EVENTS pass: the artifact endpoint served nothing and gated nothing

### `GET /api/artifacts/:id` was specified as "stream; project-scoped auth"

It returned a metadata JSON blob. No stream, no gating — so the Artifacts page could list
files and never open one, and the quarantine state it displayed had no teeth behind it.

Adding a stream is where the interesting part is, because `artifacts.path` is **data** and
artifact content is **untrusted**. Three things had to be true at once:

1. **Quarantine gate.** An artifact that is `pending` or `blocked` is never served — not to
   a model, not to the browser. Returns 409 naming the state.
2. **Path containment.** `path.resolve` against the artifacts root with a
   `startsWith(root + sep)` check, because a stored path of `../../../etc/passwd` would
   otherwise be read straight off the disk. An escape attempt is audited as
   `security.isolation`.
3. **Never inline.** Always `Content-Disposition: attachment`, `X-Content-Type-Options:
   nosniff`, and a `default-src 'none'; sandbox` CSP. The console shares this origin with
   the session cookie, so rendering an attacker-supplied HTML artifact here would be
   same-origin script execution. Metadata stays the default response; `?download=1` streams.

Verified live, all four paths:

```
clean       → 200, attachment; filename="probe.txt", nosniff, sandbox CSP, bytes correct
pending     → 409 artifact_quarantined
../../etc/passwd → 400 bad_path, audited
no ?download → metadata JSON as before
```

The Artifacts page now has a Download control for clean files, and says plainly why it is
a download rather than a preview.

### `X-Request-Id`

The doc requires a correlation id and "no stack traces to UI". Neither existed. Every
response now carries `X-Request-Id` — echoed when the caller supplies one, generated
otherwise — and the error handler returns `{error:{code,message,request_id}}` with the
stack logged server-side only. A report of "it failed at about 2am" is now traceable to a
log line.

### Acceptance: 23 → 24

```
[PASS] API: request_id=True, quarantine_gate=True, unknown_404=True
```

**24/24 PASS.**

### Note on the remaining API gap

`POST /api/inbox` is specified to accept **multipart** for file upload, and does not — it is
JSON only, so the composer's Attach button appends a filename rather than uploading bytes.
That needs `@fastify/multipart`, an artifact-write path, and a scan step before anything is
served (the gate above is ready for it). It is the honest next piece of that feature rather
than something to half-add; noted rather than quietly skipped.

### Next

1. `POST /api/inbox` multipart upload → artifact + scan + the gate built this tick.
2. ADRs 001, 002, 006, 010–014 detail pass.
3. Remaining §39–§43 UI gaps.

---

## Tick 14 — Attachments end to end, and a health signal that could only go down

### Uploads: persist-first for bytes

`POST /api/inbox` is specified to accept multipart and did not, so the composer's Attach
button appended a filename and uploaded nothing. Now implemented properly:

- The file streams to `quarantine/` with a running SHA-256 and a hard 25 MB cap enforced
  **in the stream**, so an oversized upload is cut off rather than written and then
  rejected.
- `scanFile()` checks extension, size, and magic bytes. There is no AV daemon on this box,
  so the scan is structural and says so — a real scanner drops into that one function
  without touching the state machine around it.
- **Clean** files move into the project's artifact directory; **blocked** files stay in
  quarantine with an artifact row, so the Inbox still shows what arrived while the bytes
  stay unreachable. A refusal raises an Issue.
- The model is told what arrived — filename, size, verdict — never the contents of an
  unscanned file.
- The composer now really uploads, shows queued files, lets them be removed, and reports a
  refusal in plain words.

Verified live, including the case that matters most:

```
upload-ok.txt      → clean,   downloads (200)
upload-bad.exe     → blocked, .exe not accepted
upload-script.txt  → blocked, looks like a shebang script   ← disguised by extension
blocked download   → 409 (the T13 gate)
```

The magic-byte check catching a script renamed to `.txt` is the point of doing this at the
content level rather than trusting the name.

One detail corrected on review: blocked files were storing a path of
`../quarantine/<file>`. The gate stops them anyway, but persisting a string with `..` in it
invites a future call site to use it. Now a non-traversing `quarantine/<file>` marker.

### The health signal could only go down

Adding the upload tests pushed the suite to ~12 Supervisor turns per run and exhausted the
Groq free tier — which surfaced a flaw I introduced in tick 1: **a 429 marks a route
`degraded` and nothing ever restored it.** After a busy run every route was degraded,
`healthy_routes=0`, and `/api/health` said `missing` while chat was working fine through
the fallbacks. A health signal that only decays is worse than none.

Three fixes:

1. `reprobeDegradedRoutes()` — the health job re-probes degraded routes every 10 minutes
   and restores the ones that answer. Health can go back up.
2. Failover no longer waits on a rate-limited route when another provider is available.
   It retries with backoff **only on the last candidate**. A turn that was taking up to
   16 s to fall through now answers in 0.6 s.
3. `healthy | degraded | missing` are reported separately instead of collapsing to a
   boolean. A rate-limited primary with a working fallback is `degraded`, not an outage,
   and composing stays enabled.

### Two tests that were asserting the wrong thing

- **UPLOAD** required the Supervisor turn to succeed before checking the scan verdict. But
  persist-first means the bytes are stored and scanned *before* that turn — so a provider
  429 was failing a test about file scanning. It now accepts 200 or 502.
- **ADR005** asserted "prose gets an answer", which a free-tier 429 also fails. The
  property under test is that prose is **not held by the filter**; whether the provider
  then answers is L4's job. Renamed to `prose_not_held`.

Both were my tests measuring the wrong thing, not the system misbehaving — worth being
explicit about, because a test that fails for an unrelated reason trains you to ignore it.

### Acceptance: 24 → 25

```
[PASS] UPLOAD: clean=True, exe_blocked=True, disguised_script_blocked=True, download_gate=True
[PASS] L4:     routable=3 across 2 providers, live_reply=True
[PASS] ADR005: prose_not_held=True, code_held=True, routing_issue=True
```

**25/25 PASS.**

### Worth knowing

The suite now fires roughly a dozen Supervisor turns per run and reliably rate-limits the
Groq free tier for a few minutes afterwards. Nothing breaks — the fallback chain covers it
— but back-to-back runs will show `degraded` routes. Worth trimming the suite's chat turns
if it becomes noisy.

### Next

1. ADRs 001, 002, 006, 010–014 detail pass.
2. Remaining §39–§43 UI gaps.
3. Acceptance probe rows accumulate; add a cleanup step.

---

## Tick 15 — I broke task claiming in tick 10 and the suite did not catch it

### The bug

The ADR 007 starvation cap I added in tick 10 joined `projects` into the claim query:

```sql
SELECT t.id FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
 ... FOR UPDATE SKIP LOCKED
```

Postgres refuses that: *"FOR UPDATE cannot be applied to the nullable side of an outer
join."* **`claimTask` has thrown on every call since tick 10** — the worker could not claim
anything, and 87 `health` tasks piled up `queued`.

I only found it because a *different* change made me read the worker log. Fixed with
`FOR UPDATE OF t`, which is exactly what that clause is for. All 87 backed-up tasks drained
immediately.

### Why the suite missed it

L3 asserted `stalled → recovering → queued` and stopped there. The task being **picked back
up** was the part that broke, and nothing checked it. Tick 10's log even shows the full
chain ending in `succeeded`; after the regression it silently became four states and still
passed.

L3 now waits for the round trip and asserts `reclaimed` — a recovery that never gets
claimed again is not a recovery:

```
before: ['running','stalled','recovering','queued']
now:    ['running','stalled','recovering','queued','preparing','running','succeeded']  reclaimed=True
```

That is pattern F from last tick, and this time it hid a real outage rather than causing a
flake. A test that stops one step short of the property is worth little.

### The same dedupe mistake, in a place I wrote after fixing it

The watchdog raised `worker.crash` with `dedupeKey: stuck:<task_id>` — **per task**, so
every stall left a ticket nothing would ever close. 14 had accumulated. `ERROR_TAXONOMY.md`
says `worker.crash:{lane}`, which is what it uses now, and a successful recovery resolves
it. This is the identical error I fixed in the supervisor path in tick 7, made again in
tick 10.

### Issues had become a log

38 open issues, of which ~30 were records of things the system had already handled
correctly: refused denials, blocked uploads, recovered stalls. A page meant for "what needs
Enrique" had turned into an event log, which hides the eight items that are real.

`resolveHandledIssues()` now closes tickets whose condition has cleared —
`security.broker_deny`, `artifact.corrupt`, `telnyx.quiet_hours` after 6 hours;
`worker.crash` once its lane is clear; `security.isolation` after 24 hours without
recurrence. A refused cross-project request still pages immediately and stays in the audit
trail permanently; it just stops pinning the console to "incident" forever. **A permanently
red console is one nobody reads.**

The suite also cleans up after itself now (`POST /api/acceptance/cleanup`), so test runs
stop leaving projects and tickets behind on the live box.

### ADR 006

`/var/lib/jarvis/harness-auth/` was empty. The ADR specifies a directory per auth profile
at `0700` owned by `jarvis`. Created at boot for the three host-login profiles, with
ownership set in code so it survives a container restart rather than being a one-off
`chown` I ran by hand.

### Suite quota

The upload test fired three Supervisor turns to test *file scanning*. Now one multipart
request with three files — same coverage, a third of the quota. L4's live turn retries once
after a pause, because every route being rate-limited at once is an external condition
rather than a defect.

### Acceptance: 25/25

```
[PASS] L3: …'queued','preparing','running','succeeded', reclaimed=True
[PASS] L2: state=queued, visible_in_queue=True, trail=['queued']
```

L2 also had to change: with claiming fixed, the worker takes the probe in milliseconds, so
asserting it is still literally `queued` was testing scheduler latency rather than
durability.

### Next

1. ADRs 010–014 detail pass.
2. Remaining §39–§43 UI gaps.
3. Re-read the whole worker loop for other queries that only fail at runtime.

---

## Tick 16 — Hunting for more of what tick 15 found, and one thing I nearly broke

### The SQL audit

Tick 15's bug — SQL that type-checks, builds, deploys, and then throws at runtime — is a
class, not an incident. So I swept every route: 36 read endpoints including every `:id`
shape, plus the safe write paths (issue notes and status transitions, connection test,
broker resolve, inbox reroute, task pause/resume/reprioritize, schedule update).

**Result: no 5xx anywhere.** A clean negative, which is worth recording as much as a find —
tick 15's failure was the only one of its kind.

That sweep is now `SWEEP: Endpoint Sweep (no 5xx)` in the acceptance suite rather than
something I ran by hand once. It resolves a real id per shape so the `:id` routes are
genuinely exercised, and it is exactly the check that would have caught the claim bug the
day it shipped.

### The audit itself changed live state

Running it, I posted to `/api/channel-allowlist` to check the endpoint. It returned 200 —
and `blockers.ts` treats *any* `whatsapp` allowlist row as evidence that WhatsApp is
configured. My probe had quietly resolved a real gated blocker, telling Enrique a setup
step was done when it was not.

Removed the row and confirmed the blocker is open again. Worth naming plainly: a
read-only-looking audit that writes is how monitoring ends up lying to you. The permanent
version of the sweep only issues GETs.

### ADR 013 — the composer was never gated

*"Chat is disabled until the Supervisor route is healthy."* The composer never checked. It
would happily accept a message, persist it, and then fail the turn — which is worse than
saying so up front, because persist-first means Enrique gets a stored message and an
Issue instead of an answer.

It now reads routing state from the operations summary:

- `failed` → input and send disabled, with the reason and a pointer to Models.
- `degraded` → composing stays enabled, with a line saying the primary is rate-limited and
  replies are coming from a fallback. That distinction only exists because of the
  `healthy | degraded | missing` split from tick 14; before that this would have been an
  all-or-nothing block during every free-tier rate limit.

### Acceptance: 25 → 26

```
[PASS] SWEEP: checked 36 endpoints, broken=none
```

**26/26 PASS.**

### Next

1. ADRs 010–014 remaining detail.
2. Remaining §39–§43 UI gaps.
3. Surface auto-resolved issues distinctly so the trail stays visible without noise.

---

## Tick 17 — Host metrics, and a deploy that silently did nothing

### Plan §39 asks for CPU/RAM/disk/I/O

The Command Center had none of it. `src/hostmetrics.ts` reads load average, `/proc/meminfo`,
`statfs` on `/var/lib/jarvis`, and `/proc/diskstats`, deliberately describing the **host**
rather than the container's cgroup — a memory figure capped at the API's 768 MB limit would
be worse than no figure, because it looks authoritative.

Home now shows CPU load (against core count, which is the number that means something on a
shared VPS), memory, disk, and I/O since boot, ambering at 75% and reddening at 90% — the
thresholds maintenance actually acts on.

Cross-checked against the box rather than assumed:

| | Jarvis | host |
|---|---|---|
| CPU | 2% of 8 cores, load1 0.20 | `uptime`: 0.20 |
| Memory | 16.8 GB total, 15.7 GB available | `free`: 15 GiB total, ~0 used |
| Uptime | 10.5 h | `up 10:28` |
| Disk | 2% used, 511 GB free | `df`: 2% used, 476 GiB free |

The first disk reading said 5% against `df`'s 2%: I had counted root-reserved blocks as
used. `df` treats them as neither used nor available, and matching that convention matters
because `df` is what anyone will compare against. Rounding now ceilings for the same reason.

### The deploy that reported success and shipped nothing

I ran the CC build and the core tar in one chained command — and the core `tar` executed
while still `cd`'d into the **frontend** directory. It packed a `src` that does not exist
there, produced a near-empty archive, and `tar xzf` extracted it over `/opt/jarvis/core`
as a no-op. The API restarted cleanly, `/api/health` returned 200, and the deploy looked
fine. The new file simply was not there.

It only surfaced because I checked the *behaviour* — querying the endpoint for the metrics
— rather than trusting that the commands ran. Nothing was damaged (the paths were missing
rather than wrong, so nothing was overwritten), but a chained deploy that changes directory
mid-way can report success while shipping nothing. Core tars are built from the repo root
as their own step from now on.

That is the second time this loop that "the command succeeded" and "the thing works" came
apart — the first being tick 15's SQL, which type-checked and deployed and then threw.

### Acceptance: 26 → 27

`HOST` asserts the metrics are present **and plausible** — core count ≥ 1, percentages in
range, available ≤ total, uptime positive. A metric that is present but nonsense is worse
than a missing one.

```
[PASS] HOST: cpu=2% of 8 cores, mem=7%, disk=2%, uptime=10.5h
```

**27/27 PASS.**

### Next

1. Remaining §39 items: recent project activity and per-project PR/schedule/connection rollup.
2. Surface auto-resolved issues as a trail in `/issues`.
3. ADRs 010–014 remaining detail.

---

## Tick 18 — The rest of §39, and making the machine's own work visible

### Recent project activity

§39 lists it; the Command Center had no activity feed. `/api/operations/summary` now
returns the last twelve audit events, and Home renders them as a timeline with actor,
action, target, and project.

One deliberate exclusion: `broker.invoke`. Every capability resolution writes one, so an
unfiltered feed would be a wall of "broker.invoke groq" and tell you nothing. The audit log
on Settings still has all of them — the feed is for reading, the log is for searching.

### Per-project rollup

§39 asks for projects "with type, repo, current work, time, tasks, PRs, schedules,
connection health, and failures/recoveries". The table had the first half. Added:

- **active schedules** per project
- **connection health** — the worst state among that project's own connections, or
  `shared` when it uses the system ones rather than pretending it has none
- **7-day failures / recoveries**, from `tasks` and `task_transitions`

Live, this immediately said something true: `jarvis-maintenance` shows **0 failures / 20
recoveries** over 7 days. Those are the L3 watchdog probes — the rollup is reporting real
recovery activity, not a placeholder.

**PRs are not included.** There is no pull-request table in the schema; PRs are opened
through the GitHub broker in Phase 4 and never stored. Showing a zero would imply "no PRs"
rather than "not tracked yet", so the column is absent until there is something behind it.

### The trail was invisible

120 resolved issues against 13 open. Everything Jarvis had caught and closed by itself —
recovered stalls, refused denials, blocked uploads — was reachable only by scrolling "All"
past the actionable ones.

`/issues` gains a **Handled by Jarvis** view and count: resolved, owner `jarvis`. That is
the evidence the system is doing its job, kept next to but out of the list of things that
need Enrique. The empty state says so plainly rather than showing the generic "nothing
here".

### Acceptance: 27/27

No new test this tick — these are presentation changes over data the suite already asserts,
and a test that re-checks the same rows through a different endpoint would add a number
without adding confidence.

Verified by querying the behaviour after deploy, per the standing rule:

```
recent_activity: 12 events
project rollup fields missing: none
jarvis-maintenance sched=4 conn=shared fails/recov=0/20
```

### Next

1. ADRs 010–014 remaining detail.
2. §41–§43 re-read for remaining UI gaps.
3. Consider whether the 100-event Inbox cap needs pagination now that it is always full.

---

## Tick 19 — §41 time accounting, §42 service coverage, and an Inbox that stopped lying about its size

### §41: active, elapsed, waiting, paused

Task detail showed created and updated timestamps and nothing else. `src/timing.ts` derives
the four figures from `task_transitions` rather than storing counters, so they cannot drift
from the state machine and work retroactively for tasks that ran before this existed.

Each state's *duration* is bucketed: running/preparing/recovering count as active; queued
and every `waiting_*` count as waiting; paused counts as paused; terminal states have no
duration. Live on a system task: `elapsed 2s, active 2s, waiting 0s` — which is right,
because it was claimed and finished immediately.

### §42: every service the plan names

The health check covered five things. §42 names sixteen. The gap mattered more than the
count: a service that is simply absent from a health view reads as *fine*.

`/api/operations/services` now lists all of them with an explicit state, including
`not_configured` — a real answer, not an absence:

```
healthy         Jarvis API, PostgreSQL, Infrastructure, Workers, Queue,
                Providers/models, MCP/connections, Schedules, Backups, Security
not_configured  Browsers, OpenClaw, WhatsApp, Telnyx
degraded        ElevenLabs (key stored, no voice_id pinned)
```

Gated services are excluded from `overall` on purpose — they are pending setup, not broken,
and folding them in would leave the box permanently unhealthy, which is the same as having
no signal at all.

### The new view immediately caught a bug I had just written

Its first response said **Schedules: degraded**. My staleness check flagged any background
schedule with no run in two hours — which marks `weekly-prune`, `monthly-restore-test` and
`weekly-research` stale by design, every single week.

Staleness is now judged against each schedule's *own* cadence: `cronNextRun` from its last
run, with a 15-minute grace. Now reads `5 registered, 0 paused, all on cadence`, and
`overall` went from `degraded` to `healthy` — correctly, since nothing was ever wrong.

A fixed window that fires on healthy weekly jobs is the kind of alarm that teaches you to
ignore the row it lives in.

### Inbox

172 events behind a hard `LIMIT 100`, with "Most recent 100 events" under a count that was
itself capped at 100. It now pages by `received_at` with server-side filtering, reports
**true** totals (`all 172, pending 24, failed 40`), and offers "Load 50 more (N older)".
The header says how many exist and how many are loaded, rather than implying the cap is the
total.

### Acceptance: 27 → 29

```
[PASS] SERVICES: overall=healthy, 15 services, missing=none, gated=3
[PASS] TIMING:   elapsed=0s, active=0s, waiting=0s, coherent=True
```

The SERVICES test asserts every named service is present with a valid state and a non-empty
detail, and that gated services cannot drag `overall` down. TIMING asserts the buckets are
non-negative and sum to no more than wall clock — a coherence check, since a timing block
that is present but contradictory is worse than none.

**29/29 PASS.**

### Next

1. ADRs 010–014 remaining detail.
2. `inbox failed: 40` — mostly historical supervisor failures and ADR 005 holds; worth a
   pass to confirm none are unexplained.
3. Whether any Phase 4 item is ungated and worth starting.

---

## Tick 20 — The NVIDIA fallback had never worked, and the probe was hiding it

### Chasing 40 failed inbox events

Every one traced to `Supervisor failover exhausted`, and all of them were the acceptance
suite's own messages. Not user traffic — but reading the full error rather than filing them
under "historical" turned up two real defects.

### 1. Tool names with dots

```
groq/openai/gpt-oss-120b:  HTTP 429  tokens per day (TPD): Limit 200000, Used 199676
groq/qwen/qwen3.8-27b:     HTTP 429
google/gemini-3.6-flash:   HTTP 429
```

Three routes tried. **NVIDIA was never attempted** — it was marked `failed`, and
`routesForRole` only returns `healthy` or `degraded`. Its stored error:

```
Validation: Function at index 0 has an invalid name: "memory.upsert".
Only a-z, A-Z, 0-9, underscores, and dashes are allowed.
```

Every Supervisor tool is named with a dot. **NVIDIA has rejected every real turn since the
tool catalog was written** — so the "three provider" fallback chain has actually been two,
and today both hit their free-tier daily limits within minutes of each other.

Proven head to head on the live box rather than inferred:

```
dotted        400  Validation: Function at index 0 has an invalid name: "memory.upsert"
underscored   500  (NVIDIA's own transient error — past validation)
```

Tool names now go on the wire as underscores, which every provider accepts. `SUPERVISOR.md`
keeps the dotted catalog and `runTool` maps both spellings, so the documentation stays
readable and a model echoing either name still works.

### 2. The probe validated something production never sends

The catalog probe sent a single `noop` tool. Production sends ten tools with dotted names.
So NVIDIA **passed the probe and failed every real call** — the registry said `healthy`
about a route that could not serve a turn.

`probeChat` now sends the real `TOOLS` array, wired in at startup so the two cannot drift.
That is the whole point of a probe: a pass has to mean "can do the actual job".

### 3. `failed` was still a one-way door

Tick 14 gave `degraded` routes a way back. `failed` had none — so the NVIDIA route would
have stayed out of the chain forever even after the tool-name fix. Now re-probed too, on a
longer hourly interval since a hard failure is likelier to be real.

That is pattern E for the third time, and this instance was *inside the code I wrote to fix
pattern E*. The lesson is not "check for one-way signals" but "check the fix for the same
flaw it fixes".

### Result

After deploying, NVIDIA moved `failed` → `degraded` (its own 500s and cold starts, not a
schema rejection), and the chain reports **4 routable across 3 providers** for the first
time honestly:

```
[PASS] L4: routable=4 across 3 providers (google, groq, nvidia), live_reply=True
```

**29/29 PASS.**

### Worth telling Enrique

Groq's free tier is **200,000 tokens per day** and my testing consumed 199,676 of them
today. Nothing is broken — the fallbacks covered it, which is exactly what they are for —
but the primary route will be rate-limited until the daily reset, and back-to-back suite
runs are the reason. The suite is already trimmed once; if this recurs it needs trimming
again rather than being treated as background noise.

### Next

1. ADRs 010–014 remaining detail.
2. Reduce the suite's Supervisor turns further, or point them at a cheaper role.
3. Whether any Phase 4 item is ungated and worth starting.

---

## Tick 21 — Every tool-calling turn was failing, and nothing could tell

### The 400 was not a rate limit

The supervisor routes had gone `failed` again, and the stored error was not what I expected:

```
HTTP 400  'messages.13' : for 'role:assistant' the following must be satisfied
          [('messages.13' : property 'reasoning_content' is unsupported)]
```

The turn loop pushed the provider's **response** message straight back into the next
**request**. Groq's `gpt-oss-120b` returns a `reasoning_content` field on assistant
messages and then rejects that same field as input. So the first request in a turn
succeeded, the model called a tool, and the follow-up request 400'd — meaning **every turn
that used a tool failed**, on the primary route, and fell through the whole chain to
"failover exhausted".

That accounts for a large share of the 40 failures chased in tick 20; I had read the first
line of the error (`429`) and stopped, and the second and third lines were a different
fault.

Fixed by allowlisting the three fields the chat API accepts for an assistant turn —
`role`, `content`, `tool_calls` — rather than blocklisting `reasoning_content`. A response
message is not automatically a valid request message, and the next provider-specific field
should not break this again.

### Then the model lied and nothing noticed

With that fixed, a "remember this" turn replied **"Stored: Groq free tier limit is 200,000
tokens per day."** and wrote no row. The prompt explicitly forbids claiming an action
succeeded unless the tool call did — and there was no way to check, because Supervisor tool
calls were recorded nowhere. Workers have `task_events`; the Supervisor had nothing.

Every tool call now writes a `supervisor.tool` audit event with the tool name, argument
**shape** (keys only — arguments can carry pasted content), and the result. An unrecognised
tool name writes `supervisor.tool_unknown` and returns
`ERROR: no tool named X exists. Do not claim the action succeeded.` rather than a bland
string the model can narrate over.

Retested immediately:

```
supervisor.tool | memory_upsert | stored
memory_items    | Groq daily token budget is 200,000 tokens per day.
```

### Acceptance: 29 → 30

`TOOLCALL` asserts that if a reply *claims* it stored something, the row exists and a
`supervisor.tool` event was written. It skips rather than fails when no provider answered,
because provider exhaustion is L4's subject, not this one's.

```
[PASS] TOOLCALL: claimed=True, stored=True, audited=True, memory 49->50
```

**30/30 PASS.** L2 also now shows the full lifecycle — `queued, preparing, running,
succeeded` — because claiming works again.

### What this tick was really about

Two ticks ago I attributed 40 failures to "the acceptance suite exhausting the free tier".
That was true of the first error line and wrong about the cause. Reading the whole error
rather than the first line found a bug that broke every useful Supervisor turn, and the
absence of tool-call auditing meant a model could report success it had not achieved
without leaving a trace.

### Next

1. ADRs 010–014 remaining detail.
2. Reduce the suite's Supervisor turns.
3. Whether any Phase 4 item is ungated and worth starting.

---

## Tick 22 — tool use becomes visible, and a dead detector

### Tool use in the conversation

`/api/conversations/:id/messages` now returns a `tools` array per message, joined from
the `supervisor.tool` / `supervisor.tool_unknown` audit events written last tick, keyed on
`inbox_event_id`. The conversation renders them as chips under the assistant bubble, so a
turn that says it stored something shows *what it actually called*:

```
jarvis | Stored.  ->  [('memory_upsert', ok, 'stored')]
```

Verified against the live API: 8 of 340 messages in the global thread carry tool traces,
and the join matches because the assistant message inherits the user message's
`inbox_event_id`.

### The claim that wasn't

Reading that data immediately turned up a real one. At 06:22:45 the Supervisor answered
**"Stored: acceptance runs against Netcup."** — with no `supervisor.tool` event, no
`memory_items` row, and no audit activity of any kind after 06:22:39. The audit code was
already live, so this was not a historical gap. An identical fact stored at 06:14:42 by an
earlier turn made the claim look true.

The cause is history: asked a second time for something already in the thread, the model
answered from the transcript instead of calling the tool. Three changes:

1. **Prompt** — an earlier identical request in the thread does not satisfy a new one;
   `memory_upsert` is idempotent, call it again.
2. **Detection** — a reply that opens with a claim of a persistent action, in a turn where
   no tool ran, writes `supervisor.unverified_claim`. No Issue is raised: a claim can be an
   honest reference to an earlier turn, and a noisy Issue stream is worse than none. The
   conversation shows a ⚠ *claimed, no tool ran* chip so the turn reads as unconfirmed
   rather than done.
3. **Test** — `TOOLCALL2` repeats the exact failing sequence: ask, then ask again. It
   passes only if the second turn called the tool, did not claim, or was flagged.

### The detector was dead when it shipped

The first build of that detector could never fire. A heredoc turned the intended `\b` word
boundary into a literal backspace byte (0x08) inside the regex literal. It compiled, it
deployed, it read correctly in an editor, and `CLAIM_RE.test("Stored.")` was always false.

This is the twelve-defect list's pattern H in a new place — the deploy succeeded, the
feature did not exist. Two follow-ups:

- Fixed and unit-checked: `scratchpad/regex_check.mjs` extracts `CLAIM_RE` **from the
  source file** rather than a retyped copy and runs 12 cases through it. 12/12.
- `scripts/source-guard.mjs` refuses to ship any `.ts/.js/.py/.sql/.sh` under `src/`,
  `scripts/` or `migrations/` containing a control character other than tab/CR/LF. Verified
  against a planted 0x08 fixture (flags it) and a real `\b` (passes). It now runs before
  every deploy tarball.

### Skipped is not passed

`TOOLCALL`/`TOOLCALL2` recorded `PASS` with the detail "skipped — no provider answered".
That overstates what ran. The runner gained a `skip()` outcome and a `- Skipped:` line in
the report summary, so a run with skips can no longer read as full coverage.

### Provider exhaustion — real, and not a code fault

Every Supervisor route was unavailable at once for the rest of the tick:

| Route | Result |
|---|---|
| `groq/openai/gpt-oss-120b` | 429 — TPD 199,459 / 200,000 |
| `groq/qwen/qwen3.8-27b` | 429 — TPD |
| `google/gemini-3.6-flash` | 429 — free-tier quota |
| `nvidia/nemotron-3-super-120b-a12b` | **500 Internal server error** |

Failover walked all four and raised `provider.degraded` plus `supervisor.fail`; the message
was persisted and kept in every case. That is the designed behaviour, and the spec's fifth
fallback — Claude on `anthropic_personal` — is one of the gated host CLI logins. Healthy
models exist (`gemini-3.1-flash-lite`, `nemotron-3.5-lightning-30b-a3b`) but they are
utility-role by `INITIAL_MODEL_ROUTING.md`, so I did not quietly promote them into the
Supervisor chain.

The suite is the dominant consumer: ~8 Supervisor turns per run, each carrying a 12-message
history window with **unbounded** message bodies. One pasted stack trace inflates every
following turn until it falls out of the window — a cost path and a context-overflow path
at once. History messages are now capped at 2,000 characters with an explicit trim marker;
the message being answered is still passed in full.

### Not verified this tick

`supervisor.unverified_claim` is proven at the regex level (12/12 against the source) and
wired through the API and UI, but **no live turn has fired it** — no provider answered
after the fix deployed. It is not confirmed end-to-end. First thing next tick.

### Next

1. Confirm `supervisor.unverified_claim` fires on a live turn; re-run the suite.
2. Investigate NVIDIA's persistent 500 — the only non-quota failure, and the one route that
   could restore the Supervisor without waiting on a reset.
3. Give the suite its own conversation thread per run instead of sharing the 340-message
   global one.
4. ADRs 010–014 remaining detail.

### For Enrique

- **Free-tier capacity is now the binding constraint**, not code. Three providers hit their
  daily limits within one working session. The spec'd last-resort Supervisor route is
  Claude on `anthropic_personal`, which needs the gated host CLI login.
- `TELNYX_PUBLIC_KEY` is still unset in `/etc/jarvis/compose.env`, so the webhook stays
  closed by design.

---

## Tick 23 — the detector fires, and one error class counted twice

### `supervisor.unverified_claim` confirmed end-to-end

Both directions, on live turns:

- **Negative** — "Remember this exactly: …" called `memory_upsert`, so no flag was written.
  Correct: a turn that did the work is not accused of claiming.
- **Positive** — a reply of "Stored it" with no tool call produced the event, and the API
  returned it to the UI:

```
jarvis | Stored it | tools: [{'name': 'claimed, no tool ran', 'kind': 'unverified'}]
```

### A worse failure the chips exposed on their first use

At 07:11:08 the Supervisor was asked to remember `probe 1788246710`. A tool call really ran
— so nothing flagged it — but the row it wrote was **`acceptance tool probe 1788244540`**, a
string lifted from earlier in the thread. The tool succeeded; the content was wrong. A green
`✓ memory_upsert` chip would have read as done.

An A/B against a contaminated thread and a brand-new one both stored correctly afterwards,
so this is model error, not a systematic history bug — I am not building a fix on n=1. What
did change is that the discrepancy is now visible: `memory.upsert` returns the row it
actually persisted (`RETURNING body`) instead of the constant `"stored"`, so the chip reads

```
memory_upsert -> stored: echo-check 1788247086
```

Verified live against the marker that was asked for. An empty body is now refused outright
rather than persisted as a row that says nothing and reports success.

### The real defect this tick: one error class, two verdicts

NVIDIA `nemotron-3-super-120b-a12b` went `healthy` at 07:18 and `failed` at 07:20 on the
same HTTP 500. My tick-22 hypothesis — that the probe was passing on a payload production
never sends — was **wrong**: the probe reproduces nothing, the 500 is intermittent
server-side. Chasing it turned up the actual bug.

| Path | 429 | 5xx / timeout |
|---|---|---|
| Catalog probe | `degraded` | `degraded` |
| Supervisor failover | `degraded` | **`failed`** |

`routesForRole` routes `healthy` and `degraded` only, and re-probes `degraded` after 10
minutes but `failed` after 60. So an intermittent 500 seen during a real turn benched the
route for **six times longer** than the identical error seen by a probe — and it was
benching the one Supervisor route that is not free-tier quota limited.

Both paths now call a single exported `classifyRouteFailure`. Unit-checked 10 cases against
the source (429/5xx/abort/timeout/fetch-failed/socket-hang-up → `degraded`; 401/400/404 →
`failed`). `approval_state` was reading the same stale `transient` variable and now follows
the classifier too.

Also aligned: the probe sends production's `temperature` and `max_tokens` (moved to
`src/chatparams.ts` so neither module imports the other). `max_tokens` is a ceiling, not a
spend, so this costs nothing and closes the last parameter gap between probe and turn.

### ADRs — the gap was all fourteen, not 010–014

An audit against `docs/adr/TEMPLATE.md` found every required section present in every ADR
**except Rollback, which was missing from all 14**. Each now carries a specific rollback
statement, not boilerplate — what reversing that decision actually costs, and whether it is
reversible at all. ADR 008's is the blunt one: there is no rollback from a lost master key
plus a lost restic password.

### Suite: 27 PASS, 2 FAIL, 2 SKIP — and the FAILs are honest

`TOOLCALL2` did run once this tick and passed on its own terms —
`claimed=True, called_again=True, flagged=False` — so the repeat-store fix works.

By the second run the free tier was spent again: L0 `chat_ok=False` and L4
`live_reply=False`. I did **not** loosen them. `FULL_LOOPS.md` L0 step 2 is "ask Jarvis to
remember it" and step 5 is "follow-up … works" — a live reply is part of the loop, so
failing when no provider answers is the truthful result. L4's whole subject is failover.
Weakening either to get green would be the thing this loop is not allowed to do.

### Not done, and why

**A dedicated conversation thread per acceptance run** (tick-22 item 4) is not implemented.
Doing it properly needs one of two things I should not choose alone: `conversations` has no
`archived_at` and `DATA_MODEL.md` does not specify one, so either the schema gains an
off-spec column, or the cleanup endpoint starts hard-deleting rows. The contamination
hypothesis it was meant to address also did not reproduce. **Enrique's call.**

### For Enrique

- **Two FULL_LOOPS are red purely on free-tier capacity.** Three providers hit daily limits
  inside one session; the spec'd last-resort route is Claude on `anthropic_personal`, a
  gated host CLI login. This is now the binding constraint on the suite.
- **Acceptance thread question above** — schema column, destructive cleanup, or leave it.
- `TELNYX_PUBLIC_KEY` still unset in `/etc/jarvis/compose.env`; webhook stays closed by design.

### Next

1. Confirm `classifyRouteFailure` in production — NVIDIA is stuck `failed` until the hourly
   re-probe; after that a 500 should leave it `degraded` and routable.
2. Re-run the suite once quota recovers and get L0/L4/TOOLCALL green in one pass.
3. Phase 4: assess whether any item is ungated and worth starting.

---

## Tick 24 — the classifier proves itself, and three silent failures surface

### `classifyRouteFailure` confirmed in production

At 08:09:49 NVIDIA `nemotron-3-super-120b-a12b` returned HTTP 500 during a real turn and was
marked **`degraded`**. Under the previous code that identical error marked it `failed` —
dropped from `routesForRole` and benched for 60 minutes instead of 10. All four routes stayed
routable.

Then the payoff, from the new `supervisor.route` audit event:

```
08:14:07 | nvidia/nvidia/nemotron-3-super-120b-a12b | skipped=3 of 4
```

The turn was served by the **fourth** route after three 429s — FULL_LOOPS L4 step 2
("the next turn uses the next approved pair") demonstrated in production rather than assumed.
The route that tick 23 stopped wrongly benching is now the one carrying traffic.

### L4 rewritten to test the loop instead of the weather

The old L4 asserted only "some reply came back". That checks none of the five steps in
`FULL_LOOPS.md` L4 and goes red whenever every free tier is rate-limited at the same second.
The rewrite checks what is specified:

| Step | Now checked |
|---|---|
| 2 — next approved pair serves | `supervisor.route` names the route and how far down the chain it sat |
| 3 — conversation ids unchanged | reply lands in the same thread |
| 4 — exhaust → `provider.degraded`, no metered enable | attempts name ≥2 providers; no connection has metered spend on |

Step 1 (marking the primary unhealthy by hand) is deliberately **not** done — a diagnostic
must never write live registry state, and free-tier 429s supply that condition often enough.

Both branches have now been exercised for real: `served_by=nvidia/…, skipped=3` on a live
turn, and `exhausted, attempted=['google','groq','nvidia'], metered_on=0` when the pool was
spent. The old test would simply have gone red for the second one.

Which model answered is now also a chip in the conversation (`⚙ nvidia/…`), deduplicated —
a tool-calling turn makes two round-trips and logged it twice; "which model answered" is one
fact, though a turn genuinely served by two models still shows both.

### Three silent failures

**1. A blocked `.exe` reported as unblocked.** UPLOAD went red with `exe_blocked=False`. The
database said otherwise — `quarantine_state=blocked`, reason `.exe files are not accepted as
attachments`. The control worked. `_multipart` had a 30s timeout while `self.request` uses 45s
precisely because responses wait on the whole failover chain; the request stored the file, the
chain ran long, and the client gave up before the verdict arrived. A security control reading
as failed when it passed is as damaging as the reverse.

**2. Two copies of the same test, and the wrong one won.** `test_upload_scan` and `_multipart`
were each defined **twice** in the runner. Python takes the last definition, so the good
single-request version was dead and the three-request version ran — three Supervisor turns
spent scanning files, on a free tier where turns are the scarce resource. `test_api_contract`
was duplicated too (identical copies). Nothing errored; the improvement had been written and
never executed.

`scripts/source-guard.mjs` now refuses to ship a definition that shadows an earlier one of the
same name, scoped per class so two classes may each define `run`. Verified against planted
fixtures in both directions.

**3. A verified backup reporting as never verified.** L15 went red with "no restore drill has
ever run — the backups are unverified". The drill event existed and passed. L15 was scanning
`/api/audit`, which returns the newest 200 events; the audit log had grown past 200 and the
drill had fallen out of the window — helped along by the `supervisor.route` events I added
this same tick.

Measured directly rather than argued:

```
/api/audit?action=backup.restore_drill  -> 1 event, dump_bytes=120208, canary_decrypted=True
/api/audit  (newest 200)                -> drill present: False
```

`/api/audit` gained an `action` prefix filter and L15 now asks the question it means. This one
was the worst of the three: the loop that guards the backups degraded into a false alarm from
unrelated traffic, and its message asserted something untrue.

### Also this tick

- **TOOLCALL2's flag check was unscoped** — `any(action == "supervisor.unverified_claim")`
  over the newest 20 events counted a flag raised an hour earlier by my own probe. It is now
  diffed against a before-set, like `called_again` already was, so a genuinely unbacked claim
  cannot pass on someone else's evidence.
- **TOOLCALL's detail line was misleading** — `/api/memory` is capped at 50 rows, so "memory
  50->50" reads as if nothing was stored. The assertion was always sound (newest-first, so a
  new row is in the window); only the reporting lied.
- **L0 got one visible retry.** The assertion is unchanged — a 502 is still a failure of the
  loop, because L0 step 2 requires Jarvis to actually remember — but a single 429 at one
  instant is a provider condition, and the attempt count is now printed so a run that needed
  the retry cannot read as cleanly green.

### Suite

Best run this tick: **29 PASS, 1 FAIL (L0, quota), 1 SKIP (TOOLCALL2, quota)** — with L0,
L4, UPLOAD, TOOLCALL and L15 all green in the same pass at various points. Zero worker errors,
four containers up, open issues unchanged at the three expected ones.

### Not verified

Nothing shipped this tick is unverified: the classifier, the route event, the audit filter,
the duplicate guard and the upload timeout were each checked against live behaviour or a
planted fixture. What remains unproven is only whether L0 and TOOLCALL2 pass in the *same*
run — that needs quota, not code.

### For Enrique

- **Free-tier capacity is still the only thing keeping the suite from a clean sweep.** All
  four Supervisor routes ended the tick `degraded`. The spec'd fifth fallback is Claude on
  `anthropic_personal`, a gated host CLI login — this is the single highest-value gate to open.
- **Acceptance thread question from tick 23 is still open** (off-spec `archived_at` column,
  destructive cleanup, or leave it).
- `TELNYX_PUBLIC_KEY` still unset in `/etc/jarvis/compose.env`; webhook stays closed by design.

### Next

1. One clean suite pass with L0 and TOOLCALL2 green together.
2. Audit the remaining tests for the two defect shapes found here: assertions that depend on a
   truncated window, and clients whose timeout is shorter than the failover chain.
3. Phase 4: assess whether any item is ungated and worth starting.

---

## Tick 25 — the cleanest run so far, and a check that was 35 runs from going blind

### The clean pass

**30 PASS, 0 FAIL, 1 SKIP** — the best run yet, with L0 green on its first attempt and
TOOLCALL2 green in the same pass. L4 recorded `served_by=groq/openai/gpt-oss-120b, skipped=0`;
a later run in the same tick recorded the other branch, `exhausted,
attempted=['google','groq','nvidia'], metered_on=0`. Both halves of the rewritten loop now
have live evidence behind them.

Only TOOLCALL skipped, on a single transient 429 while the turns either side of it succeeded.
It now retries once, as L0 does.

### The audit for truncated-window assumptions

Tick 24's L15 failure was one instance of a shape, so I swept for the rest. Caps in the API:
`/api/audit` 200, `/api/artifacts` 200, `/api/issues` 200, `/api/notifications` 100,
`/api/memory` 50. Three tests were reading one and assuming their target was still inside it.

**L10 was the serious one.** Its silence check was:

```python
stayed_silent = len(after) == len(before)
```

`/api/notifications` is capped at 100. The outbox is at **65** and grows every run. Once it
reaches the cap that comparison is true no matter what was sent — the check that exists to
prove Jarvis stays quiet about trivial captures would have started passing unconditionally,
roughly 35 runs from now, and nothing would have said so. It now compares the newest-N **id
set**, which survives the cap: adding a notification changes the set, sending none leaves it
identical. The detail line also flags when the outbox is at the cap, because duplicate
detection genuinely only covers the loaded window at that point.

**L9** was reading the unfiltered audit list for its `security.isolation` event — the exact
window that broke L15. Now `?action=security.isolation`.

**TOOLCALL's `audited`** was `any(action == "supervisor.tool" for e in events[:20])` —
unscoped, so a previous run's tool call satisfied it. This is the same shape I fixed in
TOOLCALL2 last tick and missed in its sibling. It now diffs against a before-set, and passed
this tick with a genuinely new event, so the fix is not merely always-false.

The timeout half of the sweep came back clean: the three remaining 10s call sites hit static
routes and `/api/health`, none of which touch the failover chain. `_multipart` was the only
real instance and was fixed last tick.

### The same window, in the operator's hands

`/settings` loads the newest 200 audit events and filters them **in the browser**. An operator
searching for an older action is told "No matching records" — an absence that is only local,
on the page whose whole job is answering "who did what". When the local filter finds nothing,
the page now queries `/api/audit?action=<term>` and reports what it found as older records;
the record count says "(search finds older ones)" once the window is full.

**Not verified end-to-end:** the API half is proven (`?action=backup.restore_drill` returns the
drill, the unfiltered 200-window does not) and the page compiles and deploys, but I have not
driven the search in a browser — doing so needs a login, and typing the password into a
browser form is off limits. The React effect wiring is the one link resting on review alone.

### Phase 4 assessment

Every remaining Phase 4 item is blocked, and not on work I can do:

| Item | Status |
|---|---|
| GitHub admin + per-repo keys | credential connected; **creating real repos needs Enrique's approval** |
| Worktrees | already done — `/var/lib/jarvis/worktrees/<slug>` created at project creation, with traversal guards. Git worktrees proper need a repo |
| Harness spawn | gated — three `setup.login.*` Issues already open |
| GitHub/repo wiring, review + PR pipeline | need a repo |
| Netlify broker | **no credential exists and no Issue covers it** |
| Task grants + always-confirm | `src/grants.ts` exists; L8 passes |

So there is no ungated Phase 4 work to start. I did not raise Issues for the two uncovered
gates (GitHub repo-creation approval, Netlify credential) because the only way to create them
from here is to hand-insert rows, which is a diagnostic writing live state. **Say the word and
I will add them through the product path.**

### For Enrique

- **Open the `anthropic_personal` host login.** It is the spec'd fifth Supervisor route and the
  single change that would stop free-tier quota being what makes the suite red. The Issue is
  already open and waiting.
- **Two gates have no Issue**: approval to create real GitHub repos, and a Netlify credential.
  Want them raised?
- **Acceptance-thread question from ticks 23–24 is still open.**
- `[maintenance] restore-test due` opened on schedule — the monthly cadence working, not a fault.
- `TELNYX_PUBLIC_KEY` still unset; webhook stays closed by design.

### Next

1. A clean pass with every provider-dependent test green together, once quota allows.
2. Sweep the Control Center for the remaining truncated-window reads now that one turned up in
   `/settings` — `/issues`, `/artifacts` and `/inbox` all read capped lists.
3. Nothing else in Phase 4 without Enrique.

---

## Tick 26 — the console was already under-reporting

### 30 PASS, 0 FAIL, 1 SKIP

Final run of the tick. The only skip is TOOLCALL on quota; L0, L4, UPLOAD, TOOLCALL2 and L15
all green. Earlier runs in the tick recorded `served_by=groq/qwen/qwen3.8-27b, skipped=1` — the
chain falling through and being seen doing it, again. Open issues down to one:
`[maintenance] restore-test due`, the monthly cadence.

### The sweep found live undercounting, not a future risk

Tick 25 fixed a check that *would* decay. This tick's sweep found pages that were **already
wrong**. Measured before touching anything:

| Table | Rows | API cap | Consequence |
|---|---|---|---|
| `issues` | 291 (281 resolved) | 200, resolved sorted **last** | resolved rows truncate first — "Handled by Jarvis" could see at most ~190 of 215 |
| `tasks` | 250 | 100 | the Work page was showing 40% of the queue, with lane counts drawn from that page |
| `artifacts` | 81 | 200 | not yet truncated, but uploads accrue every run |

The Issues page is the Needs You surface. It was quietly reporting a smaller number of
Jarvis-handled issues than the truth, and the gap widens every time Jarvis resolves something —
the metric that measures Jarvis working best is the one that decays fastest.

`/api/issues`, `/api/tasks` and `/api/artifacts` now return a `totals` object counted in SQL
across the whole table, following the convention `/api/inbox` already established in this
codebase. The pages use the totals for headline stats and keep the page for the list, saying
so where the two differ ("190 of 215 shown — newest first", "N shown of 250 tasks").

Verified against the database rather than asserted:

```
/api/issues    page=200  totals={all:291, open:10, handled:215, waiting_user:7}
/api/tasks     page=100  totals={all:250, system:250}
/api/artifacts page=81   totals={all:81, quarantined:54, bytes:1613}
db             issues handled=215 open=10 all=291 | artifacts 81/54/1613 | tasks 250
```

One near-miss worth recording: my first `due_soon` SQL used a **seven**-day window while the
Artifacts page has always meant **three**. Wiring that in would have changed what the number
meant while looking like a bug fix. The server now matches the page's definition.

### What else reads those lists

Home's `needs_you_count` builds from `LIMIT 20` queries on approvals and action requests, so it
could understate the same way. Measured: **0 pending approvals, 7 live action requests** — well
inside the limit. Latent, not live. Home's open/critical issue counts come from a `GROUP BY`
over every unresolved issue, so those are already right. Nothing changed here; recording it so
the next person does not re-derive it.

### UPLOAD stops depending on a model turn

UPLOAD went red twice more, once with all three verdicts false. The datastore said otherwise
both times — `clean`, `blocked`, `blocked`, correctly scanned at 10:32:16. `/api/inbox` runs a
Supervisor turn before it answers, so an exhausted failover chain empties the response and a
correctly blocked `.exe` reads as unblocked.

Raising the client timeout is a treadmill — 30s last tick, 45s this one. The scan verdict does
not depend on the model turn, and the stored row is what the download gate enforces against
anyway, so the test now reads verdicts from `/api/artifacts`, scoped to artifact ids created by
its own request. Matching on filename alone would have found a previous run's row and passed on
its evidence. `new_artifacts=3` in the detail line proves the scoping works.

### A failure nobody could attribute

L4 went red with every visible sub-check reading correct: `exhausted, attempted=[3 providers],
same_thread=True, metered_on=0`. The answer was in `persisted`, which nothing printed. My first
hypothesis — a client timeout — was **wrong**: the slowest request in that window was 20.3s
against a 45s timeout.

Rather than keep guessing I made it observable. L4 now reports `post_status` and `persisted`,
and the body is read defensively because `self.request` returns a string, not a dict, on a
transport failure. The next run printed `post_status=502, persisted=True` and passed. If it
recurs, it is now diagnosable instead of mysterious.

### Not verified

The `/settings` audit deep-search from tick 25 remains unverified in a browser — that needs a
login, and typing the password into a browser form is forbidden. The API half is proven. The
new `totals` are verified against the database at the API layer; the pages compile, deploy and
type-check, but their rendering is likewise unconfirmed by eye.

### For Enrique

- **Open the `anthropic_personal` host login.** Four ticks running, quota is the only thing
  between this suite and a clean sweep. The Issue is open and waiting.
- **Two gates still have no Issue** — approval to create real GitHub repos, and a Netlify
  credential. Say the word and I will raise them through the product path.
- **Acceptance-thread question** from ticks 23–25 is still open.
- If you want the page rendering confirmed by eye rather than by API, that is a two-minute look
  at `/issues` and `/work` — the stat row should read 215 handled and 250 tasks.

### Next

1. Sweep the project-detail tabs, which read the same capped endpoints per project.
2. A clean pass with TOOLCALL green too, once quota allows.
3. Nothing else in Phase 4 without Enrique.

---

## Tick 27 — per-project counts, and what the recent failures actually were

### Enrique asked what has been failing. Answer:

Issues raised in the last three hours, and what each really is:

| Category | Count | What it is |
|---|---|---|
| `security.broker_deny` | 13 | the always-confirm test denying on purpose |
| `artifact.corrupt` | 12 | the upload scan refusing `.exe` and shebang files — the control working |
| `provider.degraded` / `supervisor.fail` | 12 each | free-tier quota exhaustion |
| `security.isolation`, `worker.crash`, `setup.pending` | 6 each | acceptance probes |

All acceptance-suite noise or the known quota ceiling. **One thing was real**, and it was not in
the issue table at all: **nine notifications sat permanently `failed` in the outbox** — 8
attempts each, `whatsapp/phone transport not paired`, from 04:10–04:26. They are the setup
blockers themselves: WhatsApp pairing, Telnyx, the three host logins, Netcup SCP, Composio.

Jarvis was trying to tell Enrique over WhatsApp that WhatsApp is not paired.

Nothing was lost — every one of those blockers has a `ui=sent` twin, verified per blocker — so
they are all visible in the console. But **nothing anywhere read the outbox's failed state**.
A configured channel failing the same way would have looked identical, which is to say
invisible. Two fixes:

**Notification delivery is now a reported service.** §42 names fifteen services and this is not
one of them, so it is added to the coverage endpoint and checked by its own test rather than
folded into that list. It reports honestly and does not cry wolf — failures on a channel that
is not configured are expected, not an incident:

```
notifications | healthy | all delivered; whatsapp 9 undelivered on channels that are not paired yet
```

**Those nine will be delivered when WhatsApp is paired.** They were terminal, so pairing later
would have left exactly the blockers that asked for the pairing undelivered on that channel
forever — dual-channel delivery quietly degrading to single-channel for everything queued
before setup finished. `drainOutbox` now revives failed notifications for a channel that is
configured *now*. Verified in both directions without writing any state: today the predicate
matches **0** rows and the worker logs nothing; with `whatsapp` allowlisted it matches
**exactly the 9**.

I did not touch the retry policy. Reading it first showed the 8-attempt cap and taxonomy
backoff are deliberate, with a comment saying so — the waste I assumed was there was not.

### The project tabs were counting a page and calling it the project

Measured before changing anything: `/api/projects/:id` caps every collection at 50 per project,
and `jarvis-maintenance` has **112 display-eligible tasks**. So its Overview read "50 tasks
recorded", and — worse — `openTasks` was computed from that same truncated slice, so open work
sitting past the cut-off would not have been counted at all. Other projects are well inside the
cap (`jarvis-improvement` 23 issues, the rest single digits).

The endpoint now returns per-project `totals` counted in SQL with **the same predicates the
page uses** — `state NOT IN (succeeded, failed_terminal, cancelled)` for open tasks,
`status NOT IN (resolved, ignored)` for open issues — checked against the page's own filters
rather than assumed. Tab badges and stats use the totals; lists say "50 of 112 recorded —
newest first". Verified live:

```
jarvis-maintenance: tasks_page=50  totals={tasks:112, open_tasks:0, ...}
```

Two mistakes caught in my own edit before they shipped: I had renamed the tab-map variable so a
badge would have followed the *selected* tab around instead of belonging to the tab being
rendered, and I introduced a third meaning for `t` in a file that already used it for both a tab
and a task.

### Suite

**30 PASS, 1 FAIL (L0, quota), 1 SKIP (TOOLCALL2, quota).** SERVICES now covers 16 services with
`missing=none`. L4 recorded `served_by=nvidia/…, skipped=3, post_status=200` — the full chain
falling through and being seen doing it.

### Not verified

The revive path is proven by predicate arithmetic, not by a live pairing — confirming it fires
would mean adding an allowlist row, which is a diagnostic writing live state. The page rendering
of the new per-project totals is confirmed at the API layer only, as with tick 26's.

### For Enrique

- **The nine undelivered blockers are the strongest argument yet for opening
  `anthropic_personal`** — and for pairing WhatsApp when you are ready. Both are already Issues,
  and the WhatsApp ones will now deliver themselves the moment pairing lands.
- The two gates with no Issue (GitHub repo approval, Netlify credential) and the acceptance-thread
  question are still open.

---

## Tick 28 — the sweep finishes, and the fix gets a guard

### The truncated-window sweep is complete

Every remaining surface checked and **measured**, not assumed:

| Surface | Verdict |
|---|---|
| `/api/queue` | **no cap at all** — bounded by a deliberate 24-hour window on completed tasks plus everything active. Correct by design |
| `/api/connections` | no cap; 8 rows |
| `/api/schedules` | no cap on the outer query; 5 rows |
| `/api/approvals` | cap 100; 1 row |
| `/api/inbox` | already properly paginated with a server-side total — the reference the others should have followed |

So the real instances were the four already found: `/settings` (tick 25), issues/tasks/artifacts
(tick 26), per-project (tick 27) — plus two siblings caught here.

### The siblings

`/maintenance` and `/improvement` read `/api/projects/<slug>` — the very endpoint whose caps
tick 27 fixed — and were still tallying the arrays themselves. Maintenance showed "50 tasks" for
a project with 121 display-eligible, and its open-issue count came from a truncated slice.
Improvement's task and memory stats have the same shape; that project is under the cap today, so
it was not yet wrong, only waiting to be. Both now use the server totals.

This is pattern N for the third time: fixing an endpoint is not fixing its consumers, and the
consumers are rarely in the file you just edited.

### A guard for three ticks of work

Nothing tested that the totals exist. A refactor that dropped `totals` would send every page
back to counting its own page, restoring the undercount with nothing to say so — the same
silence that let it run for weeks in the first place.

`TOTALS` pins the invariant that a total can never be smaller than the page it summarises,
across all four endpoints. It passes and, usefully, prints the live gap:

```
/api/issues=200/359, /api/tasks=100/291, /api/artifacts=99/99, project=50/121
```

The console is currently showing 200 of 359 issues and 100 of 291 tasks — and reporting the
right headline numbers anyway, which is the whole point of the last three ticks.

### Suite

Best run this tick: **30 PASS, 0 FAIL, 2 SKIP** (both tool tests, quota) with L0 green and L4
recording `served_by=nvidia/…, skipped=3`. A later run went 30 PASS / 1 FAIL (L0, quota) /
2 SKIP. Zero worker errors throughout; 16 services, `missing=none`.

One reporting note: L13 now shows `quiet_hours=False` where earlier ticks showed `True`. That is
the clock, not a regression — quiet hours ended. The test asserts the policy is *readable*, not
its value.

### Not verified

Page rendering for the new maintenance/improvement counts is confirmed at the API layer and by
HTTP 200 on each route, not by eye — seeing them needs a login, and typing the password into a
browser form is off limits. The outbox revive remains proven by predicate arithmetic rather than
a live pairing.

---

## Tick 29 — final. 31 PASS, 0 FAIL, 1 SKIP

The best run of the night, and the first with every list-contract and delivery check in place:

```
31 PASS · 0 FAIL · 1 SKIP (TOOLCALL2, quota)
16 services, missing=none · overall healthy · zero worker errors · four containers up
L0  chat_ok=True (attempts=1)
L4  served_by=nvidia/nemotron-3-super-120b-a12b, skipped=3, post_status=200, persisted=True
TOTALS  /api/issues=200/370, /api/tasks=100/303, /api/artifacts=102/102, project=50/124
```

### Correction: NVIDIA has not retired that model

Earlier this morning I told Enrique that `nvidia/nemotron-3-super-120b-a12b` had been dropped
from NVIDIA's catalog, reading a single HTTP 404 while sibling models on the same key stayed
healthy. **That was wrong.** Its current `last_error` is back to the intermittent
`HTTP 500` it has shown all night, the route is `degraded` rather than `failed`, and it served
this final run's L4 turn after skipping three rate-limited routes ahead of it.

One sample, one confident conclusion — defect pattern J, this time in my own reasoning rather
than in the code. The `provider.model_retired` Issue path shipped for it is still worth having
(a permanent 4xx genuinely needs a person to re-pin, and nothing surfaced that before), but it
was built on a misread and has not fired. It deployed after the 404 had already passed.

### Harness CLIs installed (Enrique lifted the gate mid-run)

Enrique asked to authenticate Anthropic / Codex / Cursor, which had been Issue-only all run. The
host had **no Node at all** — everything ran in Docker — so Node 22 went in first, matching
ADR 011, then all three CLIs:

| | Version | Profile dir (ADR 006, `0700 jarvis`) |
|---|---|---|
| Claude Code | 2.1.252 | `harness-auth/anthropic_personal` |
| Codex | 0.152.0 | `harness-auth/openai_codex_personal` |
| cursor-agent | 2026.08.31 | `harness-auth/cursor_personal` |

Each headless flow was probed to find the form that actually works remotely rather than guessed:
Codex refuses its localhost-callback flow on a remote box and names `--device-auth` itself;
Cursor needs `NO_OPEN_BROWSER`; Anthropic prints a URL and waits for a pasted code. The three
commands were handed to Enrique to run in his own terminal — the sign-in needs his account
credentials, and those do not pass through this agent. One aborted OAuth attempt from probing
was killed; nothing is left running.

### The run in one line

Ticks 22–29 turned a system that could *claim* work into one that has to *show* it: tool calls,
serving routes, delivery outcomes and true counts are all now recorded and readable, and the
tests that check them fail honestly instead of passing on absent evidence.

---

## Tick 30 — the host logins land, and Jarvis finally notices

Enrique completed all three sign-ins. Verified rather than taken on trust:

```
anthropic  loggedIn: true, authMethod: claude.ai   (subscription, not API billing — ADR 006)
codex      Logged in using ChatGPT
cursor     Logged in as <account>
```

### The logins would have been invisible

`auth_profiles.harness_auth_dir` is what suppresses the `setup.login.<id>` blocker and marks a
profile usable for harness spawn. **Nothing ever wrote it.** All three logins could be completed
on the VPS and Jarvis would have kept paging about them forever, with the profiles still
unusable — pattern A, on the one column the whole gate depends on.

`detectHostLogins` now runs each worker pass. Directory existence is not evidence (they are
created at boot), so it checks the credential file each CLI writes on success — presence and
non-emptiness only, contents never read:

| Profile | Proof file |
|---|---|
| `anthropic_personal` | `.credentials.json` |
| `openai_codex_personal` | `auth.json` |
| `cursor_personal` | `.config/cursor/auth.json` |

On the first pass after deploy:

```
harness login detected: anthropic_personal
harness login detected: openai_codex_personal
harness login detected: cursor_personal
```

All three `setup.login.*` Issues resolved themselves. Needs You dropped 8 → 7, open issues 11 → 6.

### Permissions, and a page that could never render

ADR 006 says `0700` dirs and `0600` files. The credential files were correct, but three files
the CLIs wrote were `0644` (`cli-config.json`, `agent-cli-state.json`, a codex lock). The parent
dirs are `0700` so nothing outside the jarvis user could reach them, but the mode is the policy
and a future project uid with group access would rely on it. Tightened; all three CLIs still
report signed in afterwards.

Then a second gap: `/api/connections` is driven by the `connections` table, and subscription
logins live only in `auth_profiles`. So the Connections page's `isHostLogin()` branch — with copy
written specifically for them — **could never render**, because those rows never reached it. The
endpoint now unions in `subscription_login` profiles with no connection row, treating
`harness_auth_dir` as the credential. The suite confirms it:

```
CONN: active credentials: anthropic_personal, backup_b2, cursor_personal, elevenlabs,
      github_personal_admin, google_ai, groq, nvidia, openai_codex_personal
```

One follow-on caught in my own change: health was only reconciled when the directory
*transitioned*, so the second pass had nothing to update and the profiles sat at `unknown` after
already being recorded. Health is now reconciled every pass against the same evidence.

### Suite

**31 PASS, 0 FAIL, 1 SKIP** (TOOLCALL2, quota). L11 still passes —
`project-owned profiles=0, leaked into system roles=none` — so surfacing the harness profiles
did not weaken isolation.

### Open question: Claude as the fifth Supervisor route

`INITIAL_MODEL_ROUTING.md` names Claude on `anthropic_personal` as the last Supervisor fallback,
and it now works headless — `claude -p --output-format json` returned in 3.4s as the jarvis user
on the subscription.

But it is a **different transport**. `chatCompletionWithFailover` speaks OpenAI-compatible HTTP
with a `tools` array; Claude Code's print mode has its own tool system and will not call Jarvis's
tools. Wiring it naively produces a fallback that can talk but silently cannot act — the exact
failure this run spent eight ticks eliminating. Not doing that without Enrique choosing it
knowingly.

---

## Tick 31 — 33 PASS, 0 FAIL, 0 SKIP

The first fully clean run of the project. Both of Enrique's choices shipped.

### Option 3 — harness lane: honest, not finished

The three host routes flipped to `approved/healthy` on their own once
`detectHostLogins` set profile health, so the registry side needed nothing:
`claude-sonnet-host` (senior_engineer + reviewer, order 5), `codex-host` (15),
`cursor-acp-host` (20).

But the heavy lane is a **stub**. It parked every task with "ACP harness host login not on this
box yet" and raised an Issue asking Enrique to complete a login he had just completed — a gate
telling him to redo finished work. The lane now checks whether any profile has a
`harness_auth_dir` and parks with the true reason, under a different dedupe key so resolving the
login does not leave the old ticket standing.

What actually blocks a real runner is architectural, and it is Enrique's call: **the CLIs are
installed on the host, while the worker is a container that bind-mounts every profile directory
as root.** ADR 006 wants one profile dir and one worktree per run. Building a partial version
that skipped that would be creating an unsandboxed code-execution path, so it was not built.

### Option 1 — subscription fallback, and it fired for real

`claude -p --output-format json` now runs from inside the API container (added to the image; the
session is read at runtime from the bind mount, never baked in) and is tried only after every
HTTP candidate fails. It runs with `--allowedTools ""` — no tools at all, because a fallback that
could touch some tools but not Jarvis's would be worse than one that plainly cannot.

It served two live turns during the suite, which is verification I could not have forced:

```
13:35:05 | supervisor.route | anthropic/claude-sonnet-host | transport=host_cli
13:35:34 | supervisor.route | anthropic/claude-sonnet-host | transport=host_cli
```

And it behaved exactly as intended:

> "I can't store it right now — the memory tool isn't available on this fallback route, so
> nothing was written. What I would do once a tool-capable route is back: call `memory_upsert`…"

### The test was wrong, not the fallback

TOOLCALL went red on that turn: `claimed=True, stored=False`. The datastore and the reply both
said otherwise. Its `claimed` check was a **substring scan** — the words "stored" and "memory"
appear in a reply that explicitly denies storing anything, so an honest answer scored as a false
claim. Pattern M again: a control that worked, reported as failed.

`CLAIM_RE` in `supervisor.ts` got this right and correctly did not fire — it anchors on a
completed action asserted up front. The test now mirrors it. My own disclaimer contained
"stored" too, and was reworded to "written or changed".

And while fixing it, `source-guard` caught a literal `0x08` in the new regex — the same
heredoc-escaping trap it was built for in tick 22, in a non-raw patch string. It paid for itself
a second time.

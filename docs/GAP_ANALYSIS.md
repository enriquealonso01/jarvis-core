# Gap analysis — why Jarvis feels shallow (2026-09-01)

Audit of `jarvis-core` as built (8,453 lines TS, 10,080 lines docs, 9 migrations,
33/33 acceptance PASS) against the planning transcript that produced the master plan.

## The finding in one line

**The executor was never built.** Everything around it was.

Jarvis today is a chat interface with eleven CRUD tools over its own Postgres
database. Every tool it has edits its own records. Nothing it can do reaches
outside the box — no repo, no browser, no scraper, no deploy, no third-party API.

## Evidence

### 1. The heavy lane parks every task it claims

`src/worker.ts:281-330`. The worker claims a heavy task, then immediately
transitions it to `waiting_for_provider` with the reason
`"harness runner not built yet"` and opens a ticket. It never spawns anything.

The only `child_process` call in the entire codebase is `src/supervisor.ts:621`,
which shells out to `claude -p` with `--allowedTools ""` — deliberately tool-less,
and it appends a disclaimer to its own answer saying nothing was changed.

There is no worktree creation, no harness spawn, no ACP client. `grep -rn "spawn"
src/` returns nothing else.

### 2. A message can never become work

The Supervisor has eleven tools (`src/supervisor.ts:15-160`):

```
memory_upsert  memory_search  project_list
project_onboarding_start / _set / _finalize
conversation_create  connection_list  connection_request
issue_create  models_list
```

There is no `task_create`. Tasks enter the system from exactly three places
(`grep -rn "INSERT INTO tasks" src/`):

| Site | Lane | Notes |
|---|---|---|
| `src/product.ts:405` | any | `/api/acceptance/task` — test probe, title must start with `acceptance ` |
| `src/product.ts:1454` | `system` | schedule fired over the internal HMAC path |
| `src/worker.ts:41` | `system` | schedule fired by the worker's own tick |

Both real paths hardcode `lane='system'`, `priority='background'`. So a WhatsApp
message, a Control Center message, an audio note — none of them can produce work.
They produce a conversation row and a reply.

### 3. "Work" is three hardcoded maintenance jobs

`runSystemTask` (`src/jobs.ts:113`) dispatches on substrings of the task title:

- title contains `health` → `healthCheck()` (disk %, RSS, route count)
- title contains `retention`/`prune` → delete old audio files
- title contains `backup`/`restore` → open a "restore-test due" ticket

That is the complete set of things Jarvis can execute. This is precisely why the
console shows only maintenance and system activity: **maintenance and system
activity is all there is.**

### 4. GitHub exists but nothing can reach it

`src/github.ts` implements `createPrivateRepo`, `provisionDeployKey`,
`createPullRequest`, `mergePullRequest`. Every caller is an HTTP route in
`product.ts` behind `requireUser` — a human clicking a button. They are not
Supervisor tools, and `createPullRequest` needs a `head` branch that something
must have already pushed. Nothing pushes.

### 5. Integrations is an empty README

`packages/integrations/` contains a `package.json` and a README describing what
it *will* hold: connection manifests, MCP adapters, Composio adapter, HTTP
adapters. Zero implementation. Composio was a founding requirement in the
transcript (message 01) and does not exist. Neither does browser control or
scraping, also explicitly requested in message 01.

### 6. The acceptance suite tests the chassis, not the car

33 tests, 33 PASS. Read the list: login, origin check, inbox persistence, queue
restart, watchdog recovery, model failover, cancel flag, action requests, broker
deny, endpoint sweep, host metrics, service coverage, time accounting, redaction,
upload scanning, path traversal, isolation, notification brevity, quiet hours,
schedules, backup drill, mobile routes, health incidents.

Not one test asserts that Jarvis *did a piece of work*. A green suite here proves
the machine is well-instrumented, not that it functions.

## Root cause: build order was inverted, then locked in

`docs/FIRST_SLICE.md` lists as explicitly **out of scope**:

> GitHub deploy keys, worktrees, ACP harnesses (logins collected now; spawn waits)

That deferral is the whole problem. Master plan §67 "Phase 4 — Engineering
capability" (GitHub broker, worktrees, coding harness adapters, tests/review/PR
pipeline) was scheduled after Phases 0/1/2/3 and **never started**. Phases 0, 1,
3 and most of 6 are done to a high standard. Phase 4 — the reason the system
exists — is at zero.

## Contributing cause: the plan's own centre of gravity

Of 91 sections in the master plan, §27 "Senior-engineer workflow" — the single
capability that makes Jarvis Jarvis — is 19 numbered lines, roughly half a page.
Error taxonomy, notification policy, backup policy, isolation, security and UI
consume dozens of sections and several thousand lines.

A faithful implementer reading that document builds the chassis, because the
chassis is what the document actually specifies. The engine got a paragraph.

## Contributing cause: the overnight loop optimised the wrong thing

`docs/acceptance/2026-09-01-overnight-loop.md` — 2,590 lines, 31 ticks. Every
tick title concerns the machine's own plumbing: notification outbox, health
signals, task claiming, artifact endpoints, ADR sweeps, error classification,
console counts. Not one tick advanced Phase 4.

An autonomous loop pointed at an acceptance suite will improve whatever the suite
measures. The suite measured the ops skeleton, so 31 ticks hardened the ops
skeleton — while the heavy lane sat parked with `harness runner not built yet`.

## Contributing cause: the free-model premise collapsed on day one

The transcript's founding constraint was free tiers (message 01: "I don't want to
pay for any services"). Migration `008_fireworks_open_primary.sql` records its own
24-hour measurement:

```
nemotron-3-super  135 turns, always as the 3rd fallback
qwen3.8-27b         9
gpt-oss-120b        9, as the nominal primary
gemini-3.6-flash    0
```

The nominal primary served 9 of 153 turns. Fireworks is now a paid route.
This was already conceded in transcript message 22. The premise is dead;
the architecture built around it (catalog probing, failover chains, route health,
degraded re-probing — a large share of `catalog.ts` + `supervisor.ts`) is
carrying weight for a constraint that no longer applies.

## What is actually missing

Ranked by how much of the felt gap each one closes.

| # | Missing | Size | Closes |
|---|---|---|---|
| 1 | **Heavy-lane runner**: worktree per task, spawn a coding harness against the project's auth-profile dir, stream output to `task_attempts`/artifacts, checkpoint, push a branch, open a PR | Large — the core | ~70% |
| 2 | **`task_create` Supervisor tool** + intent routing (message → task on the right lane/project) | Small | required for #1 to be reachable |
| 3 | **Container/host boundary decision** — CLIs are installed on the host; the worker is a container mounting *every* profile dir as root. ADR 006 wants one profile dir + one worktree per run. This is the concrete blocker `worker.ts:308` names | Design, not code | blocks #1 |
| 4 | **Integrations**: Composio adapter, MCP client, browser + scraping | Medium | the "reach the outside world" half |
| 5 | **Console default view = work** — the Command Center leads with health because health is all there is; once #1 exists, system-lane noise should be collapsed by default | Small | the "I only see maintenance" complaint |
| 6 | **Acceptance test that asserts a real outcome** — e.g. "given a seeded repo with a failing test, Jarvis opens a PR that makes it pass" | Small | stops the loop optimising plumbing |

## Recommendation: do not start over

The 8,453 lines that exist are the boring, correct, expensive-to-rebuild half:
secret encryption at rest, a fail-closed credential broker with project
isolation, a durable inbox with persist-before-model, a real task state machine
with checkpoints and watchdog recovery, a notification outbox with backoff, and
a full audit trail. That is weeks of work and it is genuinely well done — the
overnight log shows real bugs found and fixed in it.

Starting over means rebuilding all of that **and still** having to write the
executor. The executor is the only thing missing. Build the executor.

The one thing worth deleting is complexity that exists solely to make free tiers
survivable, if the decision is to run on paid open-weights routes from here.

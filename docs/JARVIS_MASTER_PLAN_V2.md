# Jarvis — Master Plan v2

- Status: **authoritative**. Supersedes `JARVIS_V1_MASTER_PLAN_v1.2.md` and `FIRST_SLICE.md`.
- Date: 2026-09-01
- Source of requirements: Enrique's planning transcript (25 messages), plus every decision taken since.
- Diagnosis this responds to: `docs/GAP_ANALYSIS.md`.
- ADRs 001–015 remain in force. Where this document and an ADR disagree on **mechanics**, the ADR wins. On **product**, this document wins.

This is written to be executed by **three agents working concurrently**. Part III assigns every piece of work to exactly one track with exclusive file ownership. Part IX is the mechanics of running them without collisions.

---

# PART 0 — WHAT JARVIS IS

## 0.1 The one-line test

> Enrique sends a voice note from his phone. Some minutes later he gets one short
> message with a link to a pull request that fixes what he described.

If that does not work, nothing else counts. Every other capability in this
document is either a path to that sentence, a way of seeing it happen, or a way
of keeping it alive.

## 0.2 What went wrong in v1, in one paragraph

v1 built the chassis and never built the engine. The heavy lane claimed tasks and
parked them; the Supervisor had eleven tools and every one of them edited Jarvis's
own database; `packages/integrations` was an empty README; the acceptance suite
passed 33/33 without ever asserting that Jarvis did a piece of work. The plan
itself caused it: §27, the senior-engineer workflow, was 19 lines out of 2,273.
This document inverts that weighting permanently.

## 0.3 The three properties that define "working"

1. **It acts.** Input becomes a task; a task becomes a change in the world — a PR,
   a deployed site, a scraped dataset, a filed record. Not a database row about a
   change in the world.
2. **It loses nothing.** Every input is durable before a model sees it. A crash,
   a reboot, a dead provider, a killed harness — none of them drop work.
3. **It stays inside its lines.** Projects are hard boundaries. A credential, a
   file, a browser profile, or a model account belonging to one project never
   reaches another, and production is never touched without a live approval.

## 0.4 What Enrique should never have to do

- SSH into the box to paste an API key.
- Ask "is it still running?"
- Discover a week later that something he said was silently dropped.
- Read maintenance chatter to find the one thing that needs him.

---

# PART I — THE EXPERIENCE

This part is the product as Enrique experiences it. It is the acceptance target
for Tracks B and C.

## I.1 WhatsApp — the primary channel

A **dedicated Jarvis WhatsApp number**, paired by QR to OpenClaw on the VPS. Not
a Business API. Enrique's own number is the only one on the allowlist.

**Inbound**, all of it durable before any model runs:
- Text, however unstructured. Half-formed thoughts are valid input.
- Voice notes → stored as an artifact, transcribed, transcript linked to the message.
- Images and screenshots → stored, scanned, attached to the conversation.
- Documents and pasted logs → stored, chunked, searchable forever.
- Forwarded messages ("look what they sent me") → treated as evidence, not as instructions.

**Routing.** Every inbound item lands in a conversation. If it names or implies a
project, it joins that project's thread; if it is new work, it opens a thread. Two
messages seconds apart about two different projects become two threads and two
tasks — never one merged blob, never one lost.

**Outbound — Jarvis is a pager, not a chatterbox** (§17):
- Trivial capture ("remember this", "store that") → **silence**. It is done; saying so is noise.
- Short executable work → one line when finished.
- Long work → one acknowledgement at the start, one result at the end, with a Control Center link. No progress chatter while healthy.
- A blocker that needs Enrique → one message, with a link that lands directly on the thing to fix.
- Weekly Improvement report → the one long message per week.

**Instruction, not just capture.** "Stop doing X", "always do Y in project Z",
"change Alpha's deploy policy" are configuration tasks. They are versioned,
applied, audited, and reversible — from WhatsApp, without opening anything.

## I.2 Phone — the conversation channel

A Telnyx number. Both directions.

**Inbound**: Enrique calls Jarvis at any hour. Accepted always.

**Outbound**: Jarvis calls Enrique. Forbidden 19:30–08:00 America/New_York.
Weekends allowed. A blocked call becomes a WhatsApp plus an Issue — never a
silent drop.

**Turn-taking.** Enrique talks; after roughly five seconds of silence Jarvis
takes the turn. He can interrupt at any point and Jarvis yields immediately.

**The voice.** ElevenLabs, one pinned `voice_id`, an English butler register.
Sparing "sir" — never twice in a reply. Never sycophantic.

**Two-tier answering** (this is a latency architecture, not a feature):
- **Tier 1 — the voice.** No tools, reasoning off, one short reply, sub-second. Its only decision is *answer* or *hand over*. Because it has no tools it must never claim anything was done.
- **Tier 2 — the desk.** The full Supervisor with every tool, running after the caller has already been answered. It does the actual work and reports back on the channel Enrique prefers.

**When Jarvis calls, unprompted.** Rare by design. Only for: a task blocked on
something only Enrique can unblock and idle over an hour; a production incident on
a professional project; a destructive action awaiting approval past its window; a
security or isolation event. Anything else waits for WhatsApp. Never inside quiet
hours — a blocked call becomes a WhatsApp plus an Issue and retries at 08:00.

## I.3 The Control Center — the console

Next.js, static-exported, served by Caddy at `https://jarvis.<domain>`. Session
cookie against the API. Single user. Mobile-first, because most of its use is
from a phone.

**The console leads with work.** Not health. Health is a strip. This is a direct
correction of v1, where health led because health was all there was.

**Navigation.** Home, Chats, Projects, Alerts, More. Everything else lives in More
and in the command palette.

### Home / Command Center
- What Jarvis is doing **right now**: the running task, its project, its phase, elapsed time, live tool events.
- The queue: what is next, what is blocked and on what.
- **Needs You**: approvals, missing API keys, failed connections — each one a single click from being resolved.
- Recent conversations across every channel.
- A health strip: services, providers, disk, RAM, backup age. Collapsed unless something is wrong.
- Every project as a card: name, personal/professional, repo, current work, open tasks, PRs, time spent, connection health, recent failures.

### Projects
The list Enrique asked for: every project at once, with type, activity, stats,
repo status, and whether it is live or dormant.

Per project, tabs: Overview, Work, Conversations, Activity, Repository,
Artifacts, Memory, Connections, Schedules, Issues, Settings.

### Work detail
Objective, phase, harness + model + auth-profile **id**, branch, the live tool
event stream, tests run, review findings, artifacts, errors, timers, checkpoints,
PR and deploy links, and the inbox events that caused it. No hidden reasoning; no
invented percentages. Unknown renders as `unknown`, never as `0`.

### Alerts / Issues
Every blocker as a ticket with an owner and a required action. An API-key request
is a ticket with a form on it. Resolve in place.

### Action pages
`/actions/<id>` — the page a WhatsApp link opens. Password-masked fields for
secrets, a plain statement of what the credential will be used for and what it
costs, submit, done. Single-use token; replay is a 409.

### Settings
Audit trail, config versions, model registry and routing, quiet hours, retention,
export.

**No sci-fi chrome. No fake percentages. No decorative dashboards.** This is an
operations console.

## I.4 A day in the life — the narratives that must work

These are the product. Part VIII turns each into a test.

- **N1 — The fix.** Voice note: "the login button is off-center on mobile in Alpha, fix it and open a PR." → transcribed, routed to Alpha, task queued, worktree cut, harness reproduces and fixes, tests run, reviewer checks, PR opened, one WhatsApp with the link.
- **N2 — The dump.** Enrique forwards a 40-message thread and three PDFs. → all stored, chunked, indexed. Silence. Three weeks later: "what did the client say about the refund window?" → answered with a citation.
- **N3 — The two-at-once.** Two voice notes, ten seconds apart, about two different projects. → two threads, two tasks, correct projects, neither lost, second queued behind the first.
- **N4 — The blocker.** Mid-task the GitHub credential is dead. → one WhatsApp with a link, the action page takes a new PAT, the connection tests, the ticket closes, the task resumes from its checkpoint. Enrique never opened a terminal.
- **N5 — The call.** He calls at 14:00 and talks for two minutes about a new project. Tier 1 keeps the conversation human; Tier 2 creates the project, sets its classification, and asks the onboarding questions in a thread he reads later.
- **N6 — The refusal.** "Merge and deploy it to production" on a professional project without the production grant. → refuses, explains in one line, creates an approval. Does not do it.
- **N7 — The self-repair.** Disk hits 85% at 03:00. Maintenance prunes images and old artifacts, records what it did, and does not wake him.
- **N8 — The weekly.** Sunday: one message listing what changed in the AI world that is worth adopting, each with a recommendation and a one-tap approve.

---

# PART II — THE MACHINE

## II.1 Processes

| Process | Where | Owns |
|---|---|---|
| `postgres` | container | all durable state |
| `api` | container | HTTP, sessions, SSE, broker, product endpoints |
| `worker` | container | schedules, watchdog, outbox, retention, worktree reaping — the **system** lane |
| `jarvis-runner` | **host systemd**, user `jarvis` | the **heavy** lane: harness spawn, worktrees, PRs (ADR 015) |
| `openclaw` | container, profile-gated | WhatsApp session, QR pairing, channel transport |
| `caddy` | container | TLS, static Control Center, reverse proxy |

The runner is on the host because subscription logins are host-user filesystem
state bound to a config directory (ADR 006). Everything else is containerised.

Host: Netcup VPS. Target ≤ €20/month. Tailscale for admin access; no public SSH.

## II.2 Data ownership

- **OpenClaw owns**: the WhatsApp session, its own device pairing, transport-level retry.
- **Postgres owns**: everything else. Projects, conversations, messages, inbox events, tasks and their whole history, issues, approvals, grants, credentials (ciphertext), artifacts metadata, schedules, model registry, audit.
- **Filesystem owns**: artifact bytes (`/var/lib/jarvis/artifacts`), worktrees (`/var/lib/jarvis/worktrees`), project checkouts (`/var/lib/jarvis/projects`), harness auth dirs (`/var/lib/jarvis/harness-auth`, 0700 per profile).

**Persist-first is absolute.** OpenClaw must not let a model answer a DM until
Jarvis has stored the event. The bridge refuses to complete if the ingest failed.

## II.3 The task lifecycle — the spine

```
captured → classified → queued → preparing → running → succeeded
                                      ↓         ↓
                              failed_terminal  waiting_for_{tool,provider,user,approval}
                                      ↓         ↓
                                  cancelled   paused / stalled → recovering → queued
```

Rules that do not bend:
- Every transition writes a `task_transitions` row with cause and actor.
- No worker reports `succeeded` without a final checkpoint. The checkpoint is what a restart resumes from.
- A running worker observes the cancel flag within one heartbeat.
- The watchdog stalls anything silent for 90s, recovers it from its last checkpoint, and records the whole path.

## II.4 Lanes and queue

- **supervisor** — conversational turns. Always responsive.
- **heavy** — engineering, browsing, scraping. One at a time on this hardware. Concurrency arrives with a GPU, not before.
- **system** — schedules, maintenance, retention.

Ordering: `critical` first, always. Then a starvation cap — a personal task at
normal or high priority that has waited 30 minutes goes ahead of professional
high work, so professional never starves personal forever. Then priority, then
age.

**Nothing is ever dropped for being busy.** If Jarvis is working and Enrique
sends three more things, all three are captured, threaded, and queued.

## II.5 Isolation

A project is a security boundary. Concretely:
- Its connections, credentials, deploy key, browser profile, worktrees, and model auth profiles are its own.
- A task in project A that asks for anything belonging to project B gets a 403, an audit row, and a `security.isolation` issue. Fails closed: anything not positively permitted is denied.
- Professional and confidential projects get a dedicated unix user, created at project-create time. Until that exists, the heavy lane refuses them.
- The Supervisor, Improvement, and Maintenance never use a project-owned auth profile.

## II.6 Resource budget

Target host ~16 GB. **Heavy concurrency is 1.** Browser QA and coding share that
one slot.

| Slice | MB |
|---|---|
| OS + page cache | 2500 |
| PostgreSQL | 1024 |
| OpenClaw | 1024 |
| API + system worker | 768 |
| Caddy | 128 |
| **Heavy runner (harness + node + git)** | **4096** |
| Browser worker (replaces part of heavy, never added) | 2048 |
| Local embeddings (system lane, idle only) | 1024 |
| Docker overhead | 1024 |
| Headroom | ~2–3 GB |

Embeddings never run while heavy work is active. Below 1536 MB `MemAvailable`,
heavy work does not start: raise `resource.ram`, let Maintenance shed embeddings
and idle browsers first.

**ADR 015 opened a hole here and it must be closed.** Every other component is a
container with a `mem_limit`. The runner is a host process with no cgroup, so the
one slice with the largest budget is the only one that is unbounded — an OOM
there takes Postgres with it. The unit therefore sets `MemoryHigh=3584M` and
`MemoryMax=4096M`, and an OOM kill is a `resource.ram` issue against the task,
not a silent restart.

---

# PART III — THE THREE TRACKS

## III.0 How the tracks do not collide

**Exclusive file ownership.** Every file has exactly one owning track. A track
never edits a file it does not own. This is the rule that makes concurrency safe,
and it is not negotiable — the first attempt at parallel work in this repo
produced two sessions writing `supervisor.ts` sixty seconds apart.

| Track | Owns |
|---|---|
| **A — Execution** | `src/runner.ts`, `src/harness/*`, `src/worktree.ts`, `src/github.ts`, `src/review.ts`, `src/worker.ts`, `deploy/jarvis-runner.service` |
| **B — Intake & Brain** | `src/supervisor.ts`, `src/inbox.ts`, `src/callagent.ts`, `src/callcontrol.ts`, `src/telnyx.ts`, `src/catalog.ts`, `src/chatparams.ts`, `src/redaction.ts`, `packages/openclaw-jarvis-bridge/*` |
| **C — Surface & Integrations** | `src/index.ts`, `src/product.ts`, `src/operations.ts`, `src/actions.ts`, `src/grants.ts`, `src/uploads.ts`, `src/siteconfig.ts`, `src/hostmetrics.ts`, `packages/integrations/*`, the whole `jarvis-control-center` repo |

**Shared and frozen.** `src/db.ts`, `src/jobs.ts`, `src/sse.ts`, `src/notify.ts`,
`src/policy.ts`, `src/isolation.ts`, `src/credentials.ts`, `src/crypto.ts`,
`src/auth.ts`, `src/hmac.ts`, `src/timing.ts`, `src/blockers.ts`, `src/services.ts`.

Any track may **read and call** these. To **change** one, the track opens a
seam-change note (Part IX.4) and the change lands on its own before dependent
work continues. No exceptions — these files are where a silent conflict becomes a
production bug.

**Migration numbers are reserved** so two tracks can never author the same file:
Track A `010–019`, Track B `020–029`, Track C `030–039`.

**Interface direction.** B writes tasks. A reads and executes them. C reads
everything and owns the outward-facing surfaces. No track reaches into another's
internals; they meet at table rows and at the frozen helpers.

---

## TRACK A — EXECUTION

> **Mission:** a task goes in, a reviewed pull request comes out.

Track A is the engine. If A is not finished, nothing else matters.

**Current state:** `src/runner.ts` exists (PR #1) — it claims heavy tasks, cuts a
worktree, spawns `claude -p`, streams a transcript, heartbeats, and honours
cancel/silence/timeout. It has never been run. It does not yet produce a PR.

### A1 — Prove the runner on real hardware
*Size: 1 day. **Critical path.** Nothing in Track A proceeds until this is green on Netcup.*

Deploy `jarvis-runner.service` to Netcup. Create `/etc/jarvis/runner.env` (0640
root:jarvis, `DATABASE_URL` only). Run one heavy task end to end.

*Done when:* a heavy task reaches `succeeded` with a real harness transcript
visible in Work detail, and the transcript is a registered artifact.

*Expect to fix:* the `stream-json` event shape, `git worktree` setup, and the
`claude` binary's path and permissions under systemd.

### A2 — Project checkouts and deploy keys
*Size: 2 days. Blocks A3.*

A project with a linked GitHub repo gets a checkout at
`/var/lib/jarvis/projects/<slug>/repo`, cloned over a **project-scoped deploy
key** — never the personal admin credential. Key provisioning already exists in
`github.ts`; wire it to project create and to first use.

*Done when:* two projects exist with different key fingerprints, and a run in
project A cannot `git ls-remote` project B's repo (assert it).

### A3 — The engineering workflow
*Size: 4–5 days. **The single biggest deliverable in the plan.***

The full §27 loop inside a single run, with each phase written to `task_events`
so Work detail can show it:

1. Preserve the original report and its attachments.
2. Load the project's `AGENTS.md` and its eligible connections.
3. Reproduce the issue where reasonably possible.
4. Inspect code, logs, browser, API, and permitted databases.
5. Determine root cause; write a plan.
6. Implement the smallest sound change.
7. Add or update meaningful tests.
8. Run lint, typecheck, unit, integration, and browser QA as the project defines.
9. Commit and push the branch.
10. Open an evidence-backed PR.

If reproduction is impossible, it says so: what it tried, what evidence is
missing, and its confidence in the proposed change. **A guess presented as a fix
is a failure**, and it must be labelled.

*Done when:* narrative **N1** passes end to end from a UI-created task.

### A4 — Independent review
*Size: 2 days. After A3.*

Before the PR is opened, a second model — different family where the project's
policy allows one — reviews the diff. Valid findings are addressed and
verification re-runs. Findings and responses attach to the task.

*Done when:* a deliberately flawed change is caught by review and corrected
before the PR exists.

### A5 — Merge and deploy under authority
*Size: 2–3 days. After A4.*


Merging and deploying are broker-gated. A natural-language instruction ("fix it,
PR it, merge it") creates a **task grant** scoped to the project, the task, the
repository, the resulting commit, the named environment, and an expiry.

Jarvis skips a redundant approval only when all of these hold: the instruction
was unambiguous, the task stayed in scope, required tests and policies passed,
the revision deploying is the one produced under the grant, and no new high-risk
condition appeared.

The grant is **invalidated** — and a fresh approval required — by any of:
1. project or environment ambiguous
2. scope materially expanded
3. a destructive database migration appeared
4. a security control would have to be weakened
5. paid billing would have to be enabled
6. secrets or permissions changed materially
7. the branch or commit changed after validation
8. the task resumed after the grant expired

Store the reason in `task_grants.invalidate_reason`. Production on a professional
project requires a live approval and defaults to off regardless of any grant.

*Done when:* **N6** refuses correctly, the personal non-production path merges
without a second click, and amending the commit after tests invalidates the grant
and raises an approval (**L7**).

### A6 — Harness resilience
*Size: 2 days. Can run alongside A4.*

Map harness failure onto the taxonomy: subscription limit reached →
`provider.cred_expired`, park and notify; silence → `process.stuck`; run limit →
`agent.loop`; dirty exit → `harness.crash`. Retry within the taxonomy's limits;
resume from checkpoint, never from the beginning.

*Done when:* killing the harness mid-run produces the full
`stalled → recovering → running → succeeded` trail with the same worktree (**L3**).

### A7 — Second harness adapter
*Size: 2 days. Any time after A3.*

Extract the harness call behind an interface and add Codex. Cursor stays
registered and unbuilt until there is a reason.

*Done when:* the same task runs on either harness by changing one field.

### A8 — The acceptance test that matters
*Size: half a day. Do it the day A3 lands, not later.*

A seeded repo with a failing test. Assert Jarvis opens a PR that makes it pass.

*Done when:* it is in the suite and green — and **before any autonomous loop is
pointed at the suite again**.

### A9 — The engineering evaluation suite
*Size: 3–4 days. Depends on A3.*

Transcript msg 09: Jarvis picks its own primaries by testing them, not by reading
vendor claims. Build a private benchmark from real issues already solved in these
repos, and score each harness/model pair on: reproduction, root-cause accuracy,
correctness, hidden tests, regression safety, test quality, tool reliability,
scope control, code quality, PR quality, unnecessary escalation, and quota
consumed.

A model **earns** the `senior_engineer` role by winning this suite. Results land
in `benchmarks`; the registry's `route_order` follows from them.

*Done when:* two harnesses have run the suite and the winner is what routing
actually uses.

---

## TRACK B — INTAKE & BRAIN

> **Mission:** anything Enrique says, on any channel, becomes the right durable record and the right task.

Track B is why the engine ever starts.

**Current state:** the Supervisor chat loop, model failover, and eleven
self-referential tools work. `callagent.ts` (two-tier voice) is in progress.
There is no way for a message to become work.

### B1 — `task_create` — the missing link
*Size: half a day. **Critical path.** Highest value-per-hour in the plan.*

A Supervisor tool that creates a task: project, title, objective, lane,
priority, and the originating conversation and inbox event. Heavy work goes to
`lane='heavy'`.

This is the single highest-value change in the entire plan. Nothing the runner
can do is reachable without it.

*Done when:* "In Alpha, fix the login button and open a PR" in the Control Center
chat produces a heavy task with the right project, objective, and provenance.

### B2 — Intent routing
*Size: 3 days. After B1.*

Classify every inbound item: capture / question / instruction / work /
configuration change. Route to memory, to an answer, to a task, or to a config
task. Ambiguity asks one short question rather than guessing.

*Done when:* **N3** passes — two messages seconds apart become two threads and two
correctly-scoped tasks.

### B3 — WhatsApp end to end
*Size: 3–4 days. Independent of Track A.*

Pair the dedicated number by QR. Bridge persists first and never lets OpenClaw's
default agent answer. Text, voice, images, documents all ingest. Reconciliation
backfills anything missed while the API was down.

*Done when:* **L1** passes, including killing the API for 10 seconds mid-send with
no drop.

### B4 — Voice notes
*Size: 2 days. After B3.*

Audio → artifact (`retention_class='raw_audio'`) → STT → transcript message
linked to the original. Raw audio deleted at 7 days, never kept past 10 unless
marked permanent.

*Done when:* **N1** starts from an actual voice note, and **L12** passes.

### B5 — Notification policy
*Size: 2 days. After B3.*

Implement §17 exactly: silence on trivial capture; one line on short work;
ack-plus-result on long work; one message per blocker with a working link; the
weekly report. Deduplicate — a repeated condition is a counter, not another page.

*Done when:* **L10** passes: a trivial capture produces zero WhatsApp messages and a
long task produces exactly two.

### B6 — Phone, both directions
*Size: 5–6 days. Largest Track B item; defer past M1.*

Telnyx inbound and outbound. Quiet hours enforced at the call site, not in the
UI. Five-second turn-taking, interruptible. ElevenLabs voice with the pinned
`voice_id`. Tier 1 answers, Tier 2 acts.

*Done when:* **N5** and **L13** pass — including an outbound call at 20:00 that is
refused and becomes a WhatsApp plus an Issue.

### B7 — Memory and knowledge
*Size: 3–4 days.*

Everything Enrique dumps is chunked, indexed, and searchable forever, scoped by
project with a global tier for Supervisor memory. Answers cite what they came
from.

*Done when:* **N2** passes across a restart.

### B8 — Configuration by conversation
*Size: 2 days. After B2.*

"Change Alpha's deploy policy", "stop doing X", "always Y" become versioned,
validated, audited, reversible config tasks — from WhatsApp.

*Done when:* a WhatsApp instruction changes a project's instructions, and
"what changed in this project's policy last week?" answers correctly.

### B9 — Model routing, shrunk
*Size: 1 day. Do it early — it removes code the other items would otherwise inherit.*

Cut to what is real: Fireworks open-weights primary plus one fallback for the
Supervisor; Claude Code on subscription for the engineer; Groq Whisper for STT;
ElevenLabs for TTS. Delete the dead free-tier chain — sixteen half-probed models
across five providers exist for a constraint that no longer applies.

Authentication is **per provider, not per model**: switching models within a
provider reuses the key and never asks Enrique again.

*Done when:* `/api/models` shows two healthy supervisor routes and no `discovered`
rows pretending to be routable.

### B10 — Project onboarding
*Size: 2–3 days. Blocks A3 — without it there is no `AGENTS.md` to read.*

Creating a project is a conversation, not a form. Jarvis must ask, and must not
guess: personal or professional; production and customer-facing status;
confidentiality; the exact GitHub owner/repo or permission to create a new
private one; which auth profiles may see this data; whether metered paid APIs are
allowed and the ceiling if so; deploy environments and approval rules; required
tests, review, backups, monitoring.

On finalize, Jarvis **writes `AGENTS.md` into the repository** from the template
in `docs/TEMPLATES.md` — classification, repo, approved auth profiles, setup/test/
lint commands, environments, forbidden actions, PR and deploy gates, default queue
priority. Every engineering task reads it. Changes are versioned in
`project_instructions_versions`.

Never bake a named customer or employer into the template; the professional
policy is generic (§28.2).

*Done when:* a project created by voice ends with a committed `AGENTS.md` whose
values match the answers given in the thread.

---

## TRACK C — SURFACE & INTEGRATIONS

> **Mission:** Enrique can see and steer everything, and Jarvis can reach the outside world.

**Current state:** the Control Center exists with all its pages and is degraded.
`packages/integrations` is an empty README — Jarvis cannot touch anything outside
its own database.

### C1 — Make the console lead with work
*Size: half a day. Do it first; it is the fastest visible improvement.*

Home shows what Jarvis is doing, what is queued, and what needs Enrique. Health
becomes a collapsed strip. The system lane is hidden by default.

*Done when:* with a heavy task running, Home's first screenful is that task — not
disk percentage.

### C2 — Repair the degraded UI
*Size: 3–4 days. Ongoing alongside everything else.*

Audit every page against real API fields. Any metric without a real source shows
`unknown`. Fix the mobile journeys first — that is where it is actually used.

*Done when:* **L17** passes: on a phone viewport Enrique can check health, add
context to a task, resolve an API-key issue, approve something, reprioritise, and
open an artifact.

### C3 — Live work detail
*Size: 2–3 days. Needs A1 running to have anything to show.*

The full Work view: phases, live tool events over SSE, tests, review findings,
artifacts, timers, checkpoints, PR links, and the inbox events that caused it.
"Live updates paused" when SSE drops for 5s.

*Done when:* an entire A3 run is legible from the console with no log access.

### C4 — The credential loop
*Size: 2 days. Needs B5 for the WhatsApp link.*

The loop Enrique asked for repeatedly: Jarvis needs a key → ticket + one WhatsApp
link → action page with a masked field, a statement of purpose and cost →
submitted straight to the broker → connection tested → ticket closed → blocked
task resumes.

*Done when:* **N4** and **L5** pass without a terminal.

### C5 — Composio
*Size: 3 days. After A3.*

The Composio adapter, so any Composio-supported service is reachable under
project scope through the broker. Connection manifests declare kind, scopes, and
permission schema.

*Done when:* a project-scoped Composio connection is used by a heavy task, and
the same connection is denied to a second project.

### C6 — Generic MCP client
*Size: 3 days. After C5.*

Jarvis can attach any MCP server, scoped to a project, with its tools surfaced to
the harness. Untrusted servers run in Docker, never on the host.

*Done when:* an external MCP server is attached to one project and invisible to
another.

### C7 — Browser and scraping
*Size: 4–5 days. After A3.*

Named in Enrique's first message and still at zero. A project-scoped browser
profile, headless control, and a scraping toolkit good enough for real sites.
Never shares a profile across projects.

*Done when:* a heavy task scrapes a real site and files the result as a
project artifact.

### C8 — Export and portability
*Size: 2–3 days. Any time.*

"Any day I want, I can move everything to another machine." One command produces
an encrypted bundle: schema, rows, artifacts, credentials (re-encryptable),
model registry, config, and the OpenClaw session. A documented restore brings it
up elsewhere.

*Done when:* a restore into a clean directory reproduces projects,
conversations, tasks, issues, schedules, a decrypted canary credential, and the
model registry (**L15**).

---

# PART IV — SHARED CONTRACTS

Frozen. These are the seams the three tracks meet at.

## IV.1 Schema
37 tables, already migrated. The task table already carries `worktree_path`,
`branch`, `head_sha`, `harness`, `external_session_id`, `auth_profile_id` — the
data model anticipated the executor even though the code never arrived. New
columns go in a track's reserved migration range and are announced as a seam
change.

## IV.2 Task and issue state machines
As in `docs/STATE_MACHINES.md`. Illegal transitions are a 409 plus an audit row.

## IV.3 Error taxonomy
As in `docs/ERROR_TAXONOMY.md`: every failure class maps to severity, whether a
retry can help, a retry limit, and a notification level. New classes are a seam
change, not a local invention.

## IV.4 Credential broker
Check order: connection exists → project allowlist → role allowlist →
confidentiality policy → spend policy → always-confirm gate. Fails closed. Every
denial is audited. Secrets are decrypted at point of use and never logged.

## IV.5 Events
SSE names are a closed set: `health`, `task.updated`, `queue.updated`,
`issue.updated`, `approval.updated`, `conversation.message`, `heartbeat`. Adding
one is a seam change.

## IV.6 Authorization levels
- **Baseline autonomous**: read, analyse, branch, test, write artifacts, open PRs on non-production personal projects.
- **Natural-language grant**: merge and deploy on non-production, bound to a SHA, invalidated when the SHA changes.
- **Always-confirm** (§13.3): production deploys, repository deletion, isolation changes, spend increases, anything destructive. A stale grant never satisfies these.

---

# PART V — SECURITY AND ISOLATION

- **Secrets**: envelope encryption, master key on disk at 0400, per-credential DEKs. Never in git, never in logs, never in `NEXT_PUBLIC_`.
- **Network**: no public SSH; Tailscale for admin; Caddy terminates TLS; Postgres bound to localhost; `/internal` is HMAC-only and not proxied.
- **GitHub**: the personal admin credential is broker-only and is used solely to create repositories. A project worker gets only its own repo's deploy key. Professional repos never touch the personal credential.
- **Professional projects**: dedicated unix user, project-owned model accounts only, no free or consumer endpoint whose terms permit training on submitted data. The Ticketflipping Anthropic subscription is used **only** for Ticketflipping.
- **Files**: uploads scanned and quarantined; executables blocked; path traversal rejected; downloads gated through the API.
- **Audit**: every broker decision, every approval, every config change, every model route, permanently.
- **Immutable without approval** (§59): isolation, authentication, audit, backup, spend ceilings, the always-confirm list, secret scope, and the authority of system projects. Jarvis may recommend changes to these; it may never make them.

## V.1 Host hardening

Debian 13 (or Ubuntu LTS). Unix user `jarvis`; per-project users created at
project-create time, none at boot. UFW default deny. Fail2ban. No password SSH
and no public SSH at all — admin access is Tailscale only. Automatic security
updates. Docker and Compose pinned. Caddy terminates TLS and is the only thing
listening publicly; Postgres, the API, and the OpenClaw gateway bind to
`127.0.0.1`. `/internal` is HMAC-only and Caddy deliberately does not proxy it.

Layout is fixed (`docs/SERVER_LAYOUT.md`): `/var/lib/jarvis` for state,
`/opt/jarvis` for checkouts and the built console, `/etc/jarvis` for
configuration. Worktrees are disposable — GitHub is canonical.

---

# PART VI — MODELS, ROUTING, COST

**Roles**: supervisor, utility, senior_engineer, reviewer, stt, voice_tts, vision, embeddings.

**Routing key**: `role + model + provider + auth_profile + project_policy`. Never
substitute a different account because it happens to be the same provider.

**Authentication is per provider.** New model, same provider, same key, no
question asked.

**A registered model is not a working route.** Nothing becomes routable until a
real tool-enabled call has succeeded against it. Transient failures degrade and
stay routable; hard failures drop out.

**Starting routes:**

| Role | Route | Cost |
|---|---|---|
| Supervisor / utility | Fireworks open-weights primary + one fallback | ~$5–10/mo |
| Senior engineer / reviewer | Claude Code on `anthropic_personal` | $0 marginal |
| STT | Groq Whisper free tier | $0 |
| Voice | ElevenLabs, pinned `voice_id` | existing |

**Budget**: VPS ≤ €20, inference ≤ $20, total under $40/month. Metered spend is
off unless Enrique sets a ceiling on that profile. No automatic paid enablement,
ever.

**Jarvis manages its own models.** When a route dies it says so, proposes a
replacement, and asks for the one key it needs — it does not fail silently and it
does not enable billing to rescue itself.

---

# PART VII — OPERATIONS

## VII.1 Health and observability
Per-service health with incident history — a flapping service must not look
identical to one that never broke. Host CPU, RAM, disk, I/O. Backup age.
Request IDs end to end. Unknown is `unknown`.

## VII.2 Self-healing (Maintenance project, seeded at boot)
Watches resources, database, queue, workers, browsers, harnesses, schedules,
backups, provider health, credentials, MCP servers, disk growth, stale
worktrees, orphaned containers, isolation checks, and config drift.

Repairs what is safe and reversible on its own. Everything destructive,
billing-related, production-impacting, or security-relevant becomes an Issue and
waits.

## VII.3 Backup
Restic to Backblaze B2, encrypted, nightly, including the database dump. A
restore drill runs monthly and records its outcome where the console can see it.
**A backup nobody has restored is not a backup** — this was already caught once
in v1, when the backups did not contain the database.

## VII.4 Improvement (seeded at boot, weekly)
Discovers new models, free tiers, provider changes, MCP servers, GitHub skills,
OpenClaw releases, harnesses, browser and scraping tools, memory systems, and
telephony improvements. Records source, licence, maintainer, activity, and
reputation. Inspects, static-checks, sandboxes, benchmarks, and evaluates
privacy, cost, and maintenance burden. Produces one recommendation per candidate.

It may build a new MCP server or adapter when none exists. It may **never**
silently activate a new provider, a paid plan, an untrusted repository, or a
weakened policy.

Output: one WhatsApp per week, each item one-tap approvable.

## VII.5 Updating Jarvis itself

With three tracks merging daily this matters more, not less. Jarvis is a
production system for one user, and the one user is also its only operator.

- Pin every version: base images, Node, Postgres, Caddy, the harness CLIs.
- Version every configuration change in `config_versions`; validate before restart.
- **Back up the database before any migration.** Migrations run inside a transaction with the file recorded in `schema_migrations`.
- Health-check after deploy; if it fails, roll back rather than investigate live.
- Keep the previous image and configuration available at all times.
- Test backend changes in an isolated Compose stack before promoting.
- Control-plane updates that touch isolation, auth, backups, or spend need an approval or a clearly scoped grant — never a bare autonomous deploy.

**Deploying core** is `git pull` in `/opt/jarvis/core`, `docker compose build`,
`up -d`, plus `systemctl restart jarvis-runner` — the runner is a separate unit
and is the piece most likely to be forgotten. **Deploying the console** is
`scripts/deploy-control-center.sh`, which syncs contents rather than replacing
the directory, because replacing it swaps the inode under Caddy's bind mount.

## VII.6 Logs and telemetry

Structured logs with a request id threaded end to end. Never log secrets,
credential values, or raw model payloads for a confidential project. Rotate and
size-cap everything — a full disk takes the whole box down. Metrics are only
those with a real source; a metric with no source renders `unknown` rather than a
plausible number.

---

# PART VIII — ACCEPTANCE

V1 is **not** launched until every critical loop is green **and** the narrative
tests pass. The v1 failure — 33/33 passing while the machine did nothing — is
prevented by making N1 a gate.

## Gate 1 — It acts *(blocks everything)*
- **N1** the fix, end to end from a voice note
- **A8** seeded failing test → passing PR
- **L0b** the happy engineering loop

## Gate 2 — It loses nothing
- **L1** capture while busy, including a 10-second API kill
- **L2** queue survives restart and full reboot
- **L3** killed harness recovers from checkpoint
- **N3** two-at-once

## Gate 3 — It stays inside its lines
- **L6** two-repo isolation, distinct key fingerprints
- **L9** cross-project probe denied and audited
- **L11** auth-profile isolation
- **L8** always-confirm blocks
- **N6** production refusal

## Gate 4 — It is usable
- **N4** credential loop with no terminal
- **L17** the six mobile journeys
- **C1** console leads with work
- **L10** notification brevity

## Gate 5 — It survives
- **L15** restore drill
- **L4** model failover with no metered enablement
- **L14** schedules, no duplicate fires
- **N7** self-repair without waking him

**Standing rule:** no test may pass by asserting a database row where it should
assert an effect. If the test does not prove something changed in the world, it
does not count.

---

# PART IX — RUNNING THREE AGENTS

## IX.1 Isolation
Each track works in its own git worktree off `main`, on its own long-lived
branch: `track/a-execution`, `track/b-intake`, `track/c-surface`. Three
directories, three checkouts, no shared working tree. The failure that produced
this plan — two sessions writing `supervisor.ts` sixty seconds apart — is
structurally impossible under this rule.

## IX.2 The contract each agent gets
1. This document, and the file-ownership table in III.0.
2. Its track's section, and only its track's section, as its backlog.
3. `AGENTS.md`, `DATA_MODEL.md`, `STATE_MACHINES.md`, `ERROR_TAXONOMY.md` as read-only law.
4. Its reserved migration range.
5. A standing instruction: **if you need to change a file you do not own, stop and open a seam-change note.**

## IX.3 Integration cadence
- Each track opens a PR per deliverable, never a batch. Small PRs merge; large ones rot.
- `main` must always typecheck and must never regress a green gate.
- Integration is daily: rebase each track on `main`, run the suite, fix drift immediately.
- A track that has not merged in two days is stuck — surface it rather than letting the branch drift.

## IX.4 Seam changes
To change a frozen file or a shared contract: write a short note (what, why,
which tracks are affected), land it as its own PR touching nothing else, tell the
other tracks, then continue. Never bundle a seam change with feature work.

## IX.5 Dependency order
```
B1 (task_create) ──┐
                   ├─→ A1 → A3 → A4 → A5   [the engine]
A1 (runner live) ──┘
C1, C2, C3 ────────── independent, start immediately
C4 ──────────────── needs B5 for the WhatsApp link
B3, B4, B6 ──────── independent of A entirely
C5, C6, C7 ──────── after A3, so there is something to use them
```
**B1 and A1 are the critical path.** Everything the product is judged on runs
through them. If a track is idle, it helps with those.

## IX.6 What every agent is forbidden to do
- Touch a file it does not own.
- Add a feature not in this document. If the gap is real, write an ADR.
- Work on the frozen ops layer: error taxonomy, outbox, quiet-hours plumbing, backups, host metrics, health incidents, ADR conformance sweeps. These are finished and good. Every hour spent there is an hour Jarvis still cannot open a PR.
- Mark something done because a row was written. Done means the effect happened.

## IX.7 Local development and testing

Every track hits this on day one, so it is settled here rather than three times.
The runner could not be tested at all while it was being written, and that is not
acceptable as a standing condition.

- **`docker compose -f deploy/compose.dev.yaml up`** brings up Postgres and the API locally with migrations applied and a seeded operator. Track C owns this file (range `030-039` if it needs schema).
- **`JARVIS_ROOT`** is already honoured by the runner; point it at a scratch directory so nothing needs `/var/lib/jarvis` on a dev box.
- **A fake harness.** Track A ships `JARVIS_HARNESS=fake`, which emits a canned `stream-json` transcript and touches a file in the worktree. It makes the whole engineering loop testable with no subscription, no network, and no Claude CLI — and it is what A8 runs against in CI.
- **Windows is not a target.** The runner spawns POSIX processes and manages unix permissions. Develop it in WSL, in a container, or on the Netcup box directly. Typecheck-only on Windows is fine; do not pretend a green `tsc` is a tested change.
- No track marks a deliverable done on a typecheck. "Done when" means observed.

## IX.8 Arbitration and blocking

- Enrique decides scope, priority, and anything touching isolation, billing, or production. Nothing else waits on him.
- A track blocked on another track for more than half a day says so rather than working around it — a workaround at a seam is how the file-ownership rule gets broken.
- Two tracks wanting the same frozen file is a seam-change note (IX.4), never a negotiation between agents.
- A track that believes the plan is wrong writes an ADR. It does not quietly diverge.

## IX.9 The work already in flight

At the time of writing there is uncommitted Track B work in the tree —
`callagent.ts` plus edits to `supervisor.ts`, `catalog.ts`, `callcontrol.ts`, and
`product.ts` — building the two-tier phone agent. Under this plan that is B6,
which is deferred past M1.

Before three agents start: commit it on `track/b-intake`, and let Track B decide
whether to finish it or shelve it. Do not leave it uncommitted in a shared tree —
that is the exact condition that produced two sessions editing one file sixty
seconds apart.

Note also that `product.ts` is Track C's file and `catalog.ts` is Track B's. That
crossing is pre-existing and needs untangling on first contact, not preserving.

---

# PART X — MILESTONES

| Milestone | Contents | Gate |
|---|---|---|
| **M1 — It acts** | B1, B9, B10, A1, A2, A3, A8, C1 | N1 green. **This is the milestone that matters.** |
| **M2 — It is reachable** | B2, B3, B4, B5, C2, C3, C4 | Gates 2 and 4 |
| **M3 — It is trustworthy** | A4, A5, A6, B8 | Gate 3 |
| **M4 — It reaches out** | C5, C6, C7, A7, A9 | Composio, MCP, scraping; a harness that earned its role |
| **M5 — It speaks** | B6, B7 | Phone and voice, N5 |
| **M6 — It survives** | C8, VII.2, VII.4, VII.5 | Gate 5, then freeze |

**M1 in dependency order.** B9 and C1 are cheap and go first. B10 must land
before A3 has an `AGENTS.md` to read. B1 and A1 are the critical path and are
worth two agents if one stalls.

```
B9 ─┐
C1 ─┤
B1 ─┼─→ B10 ─→ A3 ─→ A8   (A1 → A2 feed A3 in parallel)
A1 ─┘
```

Rough elapsed time for M1 with three agents working in parallel: **8–12 working
days**, dominated by A3. Sequentially it is closer to five weeks — which is the
argument for the three tracks.

Everything before M1 that is not on the M1 list is a distraction. That includes
voice, phone, and the weekly Improvement job — all specified, all real, all
worthless attached to a system that cannot do work.

---

## Appendix — requirements traceability

Every requirement from the planning transcript, and where it lives.

| Requirement (transcript msg) | Where |
|---|---|
| Project-scoped connections, never mixed (01, 20) | II.5, IV.4, C5 |
| WhatsApp text + voice in (01, 15) | I.1, B3, B4 |
| Phone calls both ways (06, 07, 15) | I.2, B6 |
| Butler voice, ElevenLabs (10–14) | I.2, VI |
| Software engineer, issue → merged PR (02) | A3, A4, A5 |
| Scheduled tasks (05) | II.4, VII.2 |
| Provider-level auth, not per model (10) | VI |
| Jarvis manages its own models (08, 09) | VI |
| Free/subscription models first (01, 22–24) | VI |
| Control Center with all projects + stats (15, 18) | I.3, C1, C2 |
| Queue that never loses input (15) | 0.3, II.4, B2 |
| Watchdog for stuck agents (15) | II.3, A6 |
| API-key request by link (15, 17, 18) | C4 |
| Weekly self-improvement scan (17) | VII.4 |
| Maintenance project (17) | VII.2 |
| Change instructions from WhatsApp (17) | B8 |
| Health page with actionable tickets (18) | I.3, C2 |
| GitHub repo creation + per-project scoping (19, 20) | A2, PART V |
| Dedicated Jarvis WhatsApp number (20) | I.1, B3 |
| Professional ≠ free models; TFT sub for TFT only (20) | PART V, VI |
| Audio retention 7/10 days (20) | B4 |
| Quiet hours 19:30–08:00, weekends fine (20) | I.2, B6 |
| Netcup hosting (15) | II.1 |
| Composio for MCP connections (01) | C5 |
| Scraping ability (01) | C7 |
| Exportable to another machine (01) | C8 |
| Short WhatsApps, no chatter (19) | I.1, B5 |
| Somewhere to dump everything and ask later (01) | B7, N2 |
| Jarvis tests models and picks its own primaries (09) | A9 |
| Project onboarding asks before assuming (15, 20) | B10 |
| Move everything to another machine (01) | C8, VII.5 |
| Never spend money without asking (01, 20) | VI, IV.6 |

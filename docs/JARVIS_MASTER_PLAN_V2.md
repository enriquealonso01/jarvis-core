# Jarvis — Master Plan v2

- Status: **authoritative**. Supersedes `JARVIS_V1_MASTER_PLAN_v1.2.md` and `FIRST_SLICE.md`.
- Date: 2026-09-01
- Source of requirements: Enrique's planning transcript (25 messages), plus every decision taken since.
- Diagnosis this responds to: `docs/GAP_ANALYSIS.md`.
- ADRs 001–015 remain in force. Where this document and an ADR disagree on **mechanics**, the ADR wins. On **product**, this document wins.

This is written to be executed by **one agent, sequentially**. Part III is thirty steps in order; every one of them carries its own Build, Test, Debug and Done-when. Part IX is the working discipline.

When the last step is finished, Jarvis is done.

---

# PART 0 — WHAT JARVIS IS

## 0.0 Start here

If you are the agent building this, read in this order and then begin at S1.

1. **This document, Parts 0 through III.** Part 0 is what Jarvis is and what already exists; Part III is your backlog.
2. **`docs/GAP_ANALYSIS.md`** — why v1 ended up with a chassis and no engine. Twenty minutes that will stop you repeating it.
3. **`docs/DEBUG_NOTES.md`** — eleven bugs already paid for. Read before you write, not after you break something.
4. **`AGENTS.md`** — the non-negotiables. Persist before any model call; projects are security boundaries; never substitute an auth profile.
5. **`docs/DATA_MODEL.md`, `docs/STATE_MACHINES.md`, `docs/ERROR_TAXONOMY.md`** — read-only law. The schema is already right; work with it rather than around it.

Then S1. Not S2, and not "S1 but quickly so I can get to the interesting part" — S1 is what makes every step after it verifiable instead of hopeful.

**The one thing to hold on to.** There is exactly one way this plan fails the way
the last one did: you spend your time on the parts that are pleasant to build —
the console, the taxonomy, the health checks, the elegant abstraction — and the
thing that turns a sentence into a pull request stays one step away. If you are
ever unsure what to do next, do whatever gets N1 working sooner.

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

## 0.5 Where things stand today

Read this before writing a line. A large amount already exists and is good; the
fastest way to waste a week is to rebuild it. Equally, some of it exists only as
a row in a table, and treating that as working is how v1 got here.

**Built, working, do not touch**
- Postgres schema — 37 tables across 9 migrations. It already carries `worktree_path`, `branch`, `head_sha`, `harness`, `external_session_id`. The data model anticipated the executor; only the code was missing.
- Secret storage: envelope encryption, per-credential DEKs, master key at 0400.
- The credential broker and its fail-closed isolation checks.
- Durable inbox with persist-before-model, and the OpenClaw bridge that refuses to let a model answer until Jarvis has stored the event.
- Task state machine, transitions, checkpoints, leases, the watchdog, cancel.
- Notification outbox with taxonomy-shaped backoff.
- Audit trail, health incidents, host metrics.
- Backups to B2 with restic, and a restore drill that reports where the console can see it.
- Session auth, origin checks, upload scanning, path-traversal rejection.

**Built and genuinely working — the phone**
Telnyx webhooks verified, calls answered, caller allowlist enforced, audio
recorded, Whisper transcription, ElevenLabs rendering, a greeting, and a
two-tier agent keeping the line responsive. Two hard bugs are already fixed and
documented in `docs/DEBUG_NOTES.md`. Stage 4 makes this *dependable* and gives it
the ability to act and to dial out — it does not rebuild it.

**Built but never executed**
- `src/runner.ts` — claims heavy tasks, cuts a worktree, spawns `claude -p`, streams a transcript, heartbeats, honours cancel/silence/timeout. Typechecks. **Has never been run.** S1 and S3 exist to change that, and expect the `stream-json` parsing and the worktree setup to need real fixes on first contact.

**Exists as an endpoint, unreachable by Jarvis**
- `src/github.ts` — create repo, provision deploy key, open PR, merge PR. All four work, all four are behind `requireUser`, so only a human clicking a button can call them. They are not Supervisor tools and nothing pushes a branch for them to open a PR against. S4 and S6 wire them up.

**Exists as a page, degraded**
- The Control Center has every route it needs. It leads with health because health was all there was, and several pages bind to fields that no longer exist. S12–S14 repair it rather than restart it.

**Does not exist at all**
- Any way for a message to become work (`task_create`) — S2.
- Outbound calling. Only the quiet-hours *check* exists; nothing dials — S19.
- `packages/integrations` — an empty README where Composio, MCP adapters, and HTTP adapters should be — S26.
- Browser control and scraping — S27.
- Project onboarding and `AGENTS.md` authoring — S22.
- Memory retrieval over dumped documents — S25.
- Any test that asserts Jarvis did a piece of work — S7.
- Any way to run the engineering loop without a paid subscription and a Linux box — S1.

**Carrying weight for a dead constraint**
The free-tier model chain. Migration 008 measured it: the nominal primary served
9 turns of 153 and Gemini served 0. Fireworks is a paid route now. A large part
of `catalog.ts` exists to survive a constraint that no longer applies — S21
removes it.

---

# PART I — THE EXPERIENCE

This part is the product as Enrique experiences it. It is the acceptance target
for Stages 3 and 4 especially, and the target every step is ultimately serving.

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

**Two-tier answering** — already built; a latency architecture, not a feature:
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

# PART III — THE BUILD

One agent. One step at a time. Thirty steps, in order.

Each step is **Build → Test → Debug → Done when**. A step is not finished when
the code compiles. It is finished when the "Done when" line has been *observed*.

This replaces the earlier three-track split. Sequential is slower on paper and
faster in practice here: the tracks collided at the seams within an hour of being
proposed, and one agent holding the whole system in its head makes fewer
integration mistakes than three agents coordinating through a document.

## III.0 The rules for every step

1. **Never skip the Test section.** A step whose test was skipped is not done — it is a liability wearing a green checkmark. v1 shipped 33/33 passing while the machine did nothing.
2. **A typecheck is not a test.** `tsc` proves the code parses. It proves nothing about behaviour.
3. **Test the failure path too.** Anyone can demo the happy path. Kill it, unplug it, feed it garbage, and check it fails the way the taxonomy says it should.
4. **Debug from evidence, not from theory.** Every step names the things most likely to break and where to look. Read the log before forming a hypothesis.
5. **Commit per step,** with the test evidence in the commit body. One PR per step or per tight pair. A branch spanning five steps cannot be reviewed or reverted.
6. **When something breaks twice for the same reason, write it down** in `docs/DEBUG_NOTES.md`. The call agent's self-transcription bug and its runaway-recording loop were each found the expensive way; both are now one-line comments in `callcontrol.ts`. Repeat that pattern.
7. **Do not start the next step until the current one is observed working.** Half-finished steps compound.

---

# STAGE 1 — MAKE IT ACT

Nothing else matters until Stage 1 is green. It is the whole difference between
Jarvis and a chat window.

## S1 — The test environment and the fake harness
*Size: 1 day. Do this first — every later step is tested through it.*

Today nothing can be run without Postgres, a Claude subscription, a Linux box and
`/var/lib/jarvis`. That is exactly why `runner.ts` was written and never
executed. Fix that before writing anything else.

**Build**
- `deploy/compose.dev.yaml` — Postgres + API locally, migrations applied, one seeded operator, one seeded personal project pointing at a throwaway repo.
- Honour `JARVIS_ROOT` everywhere (the runner already does) so a dev box needs no `/var/lib/jarvis`.
- **The fake harness.** `JARVIS_HARNESS=fake` makes the runner spawn a script instead of `claude`. It emits a realistic `stream-json` sequence, writes a file into the worktree, commits, exits 0. Variants by env: `fake:slow` (silent for 11 minutes — exercises the silence detector), `fake:crash` (exit 1 with stderr), `fake:runaway` (never exits), `fake:noop` (changes nothing), `fake:escape` (tries to write outside the worktree).
- `scripts/dev-seed.ts` — reset to a known state in one command.

**Test**
- Cold start on a clean checkout: migrations apply, operator logs in.
- Runner against `fake`: a task goes `queued → preparing → running → succeeded`.
- Each variant behaves as the taxonomy says: `crash` → `harness.crash`; `slow` → `process.stuck`; `runaway` → `agent.loop` at the run limit; `noop` → succeeds with an empty diff **and says so**; `escape` → blocked and audited.

**Debug**
- Migrations failing on a fresh DB usually means one depends on a later one's column. Check ordering in `schema_migrations`.
- If the runner claims nothing, the lane or `lease_until` is wrong. Query `tasks` directly before suspecting code.
- Windows is not a target for the runner — it spawns POSIX processes and sets unix permissions. Use WSL, a container, or the box.

**Done when:** someone with no Claude subscription and no network can run the entire engineering loop end to end, and all five variants behave as specified.

## S2 — `task_create`
*Size: half a day. Highest value-per-hour in the plan.*

**Build**
A Supervisor tool creating a task with project, title, objective, lane, priority
and provenance (`conversation_id`, `origin_inbox_id`). Heavy work goes to
`lane='heavy'`. Refuse to create a heavy task with no project — ask which one.

**Test**
- "In Alpha, fix the login button and open a PR" → a heavy task, right project, a real objective (not the raw message echoed), both provenance ids set.
- "Remember the client prefers Tuesdays" → memory, **no task**. Over-creating tasks is as broken as creating none.
- Ambiguous request matching two projects → one short question, no task.
- Three messages in ten seconds → three tasks, none merged, none dropped.

**Debug**
- If the model *narrates* calling the tool instead of calling it, the schema is wrong or the route lost tool support. Read the raw response body — the failure is visible there and invisible in the reply.
- Confirm the tool ran by querying `tasks`, never by trusting the assistant's own claim.

**Done when:** a sentence in the console becomes a correctly-scoped heavy task, and a non-work sentence does not.

## S3 — The runner, live on real hardware
*Size: 1 day. Critical path.*

**Build**
Deploy `jarvis-runner.service`. Create `/etc/jarvis/runner.env` (0640 root:jarvis,
`DATABASE_URL` only). Complete the Claude Code host login **as the `jarvis`
user**. Confirm the memory ceilings are in force.

**Test**
- One real heavy task end to end, transcript artifact visible in the console.
- `systemctl restart jarvis-runner` mid-run → watchdog stalls, recovers, requeues from checkpoint.
- `systemctl show jarvis-runner -p MemoryMax` confirms the ceiling is actually applied, not merely written in the file.

**Debug**
- **Expect the `stream-json` event shape to differ from assumption.** Capture one raw run to a file and read it before touching the parser.
- `claude` not found under systemd is a PATH problem — use an absolute path in `ExecStart`.
- Permission errors on `CLAUDE_CONFIG_DIR` mean the login ran as the wrong user.
- Task succeeds but the transcript is empty → stdout buffering; check the spawn's stdio.

**Done when:** a heavy task reaches `succeeded` on Netcup with a readable transcript, and a mid-run restart recovers instead of losing work.

## S4 — Project checkouts and deploy keys
*Size: 2 days.*

**Build**
Clone each linked repo to `/var/lib/jarvis/projects/<slug>/repo` using a
**project-scoped deploy key** — never the personal admin credential. Wire key
provisioning to project create and to first use.

**Test**
- Two projects, two keys, different fingerprints. Assert it; do not eyeball it.
- A run in project A cannot `git ls-remote` project B. Assert the failure.
- A run cannot read `github_personal_admin`. Assert the denial **and** the audit row.

**Debug**
- Git ignoring the deploy key means `GIT_SSH_COMMAND` is unset on the spawn, or the key is not 0600.
- A cross-project read that *succeeds* stops all other work until it is closed.

**Done when:** L6 passes.

## S5 — The engineering workflow
*Size: 4–5 days. The largest step in the plan.*

**Build**
The full §27 loop in one run, each phase written to `task_events` so the console
can show it: preserve the report and attachments → load `AGENTS.md` and eligible
connections → reproduce → inspect code, logs, browser, API, permitted databases →
root cause → plan → smallest sound change → tests → lint, typecheck, unit,
integration, browser QA per project policy → commit → push.

If reproduction is impossible it says so: what it tried, what evidence is
missing, its confidence. **A guess presented as a fix is a failure** and must be
labelled a guess.

**Test**
- Seeded repo, real bug, real fix, real test added. Read the diff by hand — this one cannot be automated away on the first pass.
- A deliberately **unreproducible** report → it says so rather than inventing a fix.
- A request outside the repo's scope → it declines rather than sprawling.
- Kill the run at each phase boundary; confirm the checkpoint resumes at that phase, not from the start.
- A repo whose tests already fail before Jarvis touches it → it reports that rather than claiming credit or blaming itself.

**Debug**
- Phases missing in the console → `task_events` is not being written. Check that before suspecting the UI.
- A harness editing outside the worktree is a containment bug: check `cwd` and permission mode.
- If it *always* claims it cannot reproduce, it probably has no way to run the project — check the `AGENTS.md` setup and test commands.

**Done when:** N1 passes end to end from a console-created task, and the unreproducible case is handled honestly.

## S6 — The pull request
*Size: 1 day.*

**Build**
Push the branch and open an evidence-backed PR through the project's API
credential: what changed, why, root cause, tests run and their output, linked task.

**Test**
- A real PR on a real private repo, readable by a human with no extra context.
- Credential missing → one issue, one notification, task parks. Not a crash.
- The same task run twice → no duplicate PR.
- A branch with no changes → no PR, and it says why.

**Debug**
- 403 on PR create is nearly always the deploy key being used where the API credential belongs. Different credentials, different scopes.

**Done when:** a PR link arrives for work Jarvis did unattended.

## S7 — The acceptance test that matters
*Size: half a day. Do it the day S5 and S6 land.*

**Build**
Seeded repo, one failing test. Assert Jarvis opens a PR that makes it pass.
Runs against the fake harness in CI, against the real harness on demand.

**Test**
Run it. Then deliberately break the runner and confirm the test goes **red** — a
test that cannot fail is not a test.

**Debug** If the test passes on a run where the harness plainly did nothing, it is asserting the task row rather than the diff. Assert on the PR's changed files and on the seeded test going from red to green — nothing else proves it.

**Done when:** it is in `scripts/acceptance-runner.py` and green — **before** any
autonomous loop is ever pointed at the suite again.

---

# STAGE 2 — MAKE IT TRUSTWORTHY

## S8 — Independent review
*Size: 2 days.*

**Build** A second model — different family where policy allows — reviews the diff before the PR opens. Findings and responses attach to the task; valid findings are addressed and verification re-runs.

**Test** Plant a flawed change (off-by-one, dropped null check, a test asserting nothing) and confirm review catches it. Then submit a *correct* change and confirm review does not invent problems — a reviewer that always finds something is noise that will be ignored within a week.

**Debug** If review always passes, check it is receiving the diff and not an empty string.

**Done when:** a planted bug is caught and corrected before the PR exists, and a clean change passes without invented findings.

## S9 — Grants, merge, deploy
*Size: 2–3 days.*

**Build** Task grants per IV.6 with all eight invalidation conditions. Merge and deploy broker-gated. Production on professional projects needs a live approval and defaults off.

**Test** Each of the eight invalidation conditions **individually**. "Fix it, PR it, merge it" on non-production personal → merges with no second click. Amend the commit after tests → grant invalidated, approval raised (L7). Production on a professional project → refused (N6).

**Debug** A grant surviving a SHA change means it is bound to the task rather than the commit. Check what is actually stored.

**Done when:** all eight conditions verified one by one, and N6 refuses.

## S10 — Recovery under failure
*Size: 2 days.*

**Build** Map every harness failure onto the taxonomy: subscription limit → `provider.cred_expired`, park and notify; silence → `process.stuck`; run limit → `agent.loop`; dirty exit → `harness.crash`. Retry within taxonomy limits, resume from checkpoint, never from the start.

**Test** Mid-run: kill the harness (L3); reboot the box; fill the disk; revoke the credential; sever the network. Each must produce the right class, the right notification, and a resumable task. Restart API and worker with three tasks queued and one running (L2) — order preserved, nothing lost.

**Debug** A task restarting from the beginning means checkpoints are written but not read. Look at the resume path, not the write path.

**Done when:** five distinct mid-run failures each recover correctly and none loses work.

## S11 — Isolation, proved
*Size: 1 day.*

**Build** Nothing new. This step exists to *prove* what earlier steps claimed.

**Test** Cross-project probe for files, secrets, browser dir, connection name, model profile — each → 403 + audit + `security.isolation` (L9). A project-owned auth profile used by the Supervisor → denied before any HTTP leaves the box (L11). Always-confirm actions blocked (L8).

**Debug** Any probe that succeeds stops all other work until it is closed.

**Done when:** L8, L9 and L11 all pass.

---

# STAGE 3 — MAKE IT VISIBLE

## S12 — The console leads with work
*Size: half a day.*

**Build** Home shows the running task, the queue, and what needs Enrique. Health collapses to a strip. System lane hidden by default.

**Test** With a heavy task running, the first screenful on a phone is that task. With nothing running, Home reads calm rather than broken.

**Debug** If Home still feels like a status page, count what is above the fold on a 375px viewport. The running task and the queue must be there before anything about disk or memory. When there is no running task, check the empty state on a real device — a calm empty state and a broken one look identical in a desktop browser.

**Done when:** disk percentage is no longer the first thing on the page.

## S13 — Live work detail
*Size: 2–3 days.*

**Build** Phases, live tool events over SSE, tests, review findings, artifacts, timers, checkpoints, PR links, originating inbox events. "Live updates paused" after 5s of SSE silence.

**Test** Watch a complete S5 run from the console with no terminal access. Kill SSE mid-run → banner appears, then reconnects and catches up without losing events. Unknown renders `unknown`, never `0`.

**Debug** Events arriving but not rendering is usually the throttle, not the transport. Inspect the raw event stream in the browser.

**Done when:** an entire engineering run is legible from a phone.

## S14 — Repair the degraded console
*Size: 3–4 days.*

**Build** Audit every page against real API fields. Mobile first.

**Test** L17's six journeys on a real phone: check health, add context to a running task, resolve an API-key issue, approve something, reprioritise the queue, open an artifact. Then every page against a project with **zero** data and one with a great deal — empty states and overflow are where consoles actually break.

**Debug** A page that renders in dev and breaks in production is almost always a field the API stopped returning; compare the live JSON against what the component destructures. If a number looks wrong rather than missing, find its source query before touching the component — v1's console under-reported for days because the count was capped upstream.

**Done when:** all six journeys work on a phone and no page shows an invented number.

## S15 — The credential loop
*Size: 2 days.*

**Build** Jarvis needs a key → ticket + one link → action page with a masked field and a plain statement of purpose and cost → submitted to the broker → connection tested → ticket closed → parked task resumes.

**Test** N4 end to end with no terminal. Expired link → refused. Replayed link → 409. Wrong key → connection test fails, ticket stays open with a useful message rather than a stack trace.

**Debug** If the parked task does not resume, the ticket closed but nothing requeued it — check the transition, not the form. A key that submits and then fails its connection test is usually being written to the wrong auth profile; confirm which profile id the broker actually stored.

**Done when:** a dead credential is repaired from a phone and the parked task resumes by itself.

---

# STAGE 4 — MAKE THE PHONE RELIABLE

The phone already works. Telnyx webhooks are verified, calls are answered, the
caller is checked against the allowlist, audio is recorded, Whisper transcribes,
ElevenLabs renders the reply, and a two-tier agent keeps the line responsive.
That is further than most of this system.

What it is not yet is **dependable**. It can hold a turn; it cannot hold a
conversation, it cannot do anything as a result of one, and it cannot ring
Enrique. This stage fixes all three.

Two bugs already cost real time and must never come back. Both are one-line
comments in `callcontrol.ts` today and regression tests after S16:

- **Self-transcription.** Recording started with the greeting, so Whisper transcribed Jarvis's own voice back as if the caller had said it.
- **The runaway loop.** Every reply's own `playback.ended` armed another recording, so one utterance produced several transcriptions, each producing a reply, each arming more sessions.

## S16 — Call reliability hardening
*Size: 2–3 days. Do this before making it smarter — a clever agent on a flaky line is worse than a dull one on a solid line.*

**Build**
- A real per-call state machine — `ringing → greeting → listening → thinking → speaking → closing` — persisted, not held in a module-level map that a restart erases mid-call.
- A deadline on every leg. STT, model, and TTS each get a budget; blowing it produces a spoken holding line, never silence.
- Graceful degradation: ElevenLabs down → Telnyx voice with a logged issue; STT returns nothing → "I didn't catch that" rather than a dead line; model fails → "give me a moment" then retry once, then offer to follow up in writing.
- Every call gets a stored transcript artifact and a conversation thread, so a call is reviewable afterwards like any other channel.
- Hang-up, caller silence, and mid-call network loss all end the call cleanly and release state.

**Test**
- **Regression first:** assert Jarvis never transcribes its own audio, and that one utterance produces exactly one reply. These two tests exist before any new feature lands.
- Restart the API mid-call. The call must survive or end cleanly — never hang.
- Force each provider to fail in turn (bad key, unroutable endpoint, 500) and confirm the spoken fallback.
- Call and say nothing for 30 seconds. Call and talk over the greeting. Call and hang up mid-sentence.
- Ten consecutive calls without a restart — no leaked state, no growing memory, no stuck `call_control_id`.

**Debug**
- Telnyx `client_state` is the only reliable way to know which playback just ended. If turns interleave wrongly, that is where to look.
- A hung call is almost always an awaited promise with no timeout. Every external call in this path needs one.
- Keep one raw webhook capture per failure mode in `docs/DEBUG_NOTES.md` — the event ordering is the hard part and it is not guessable.

**Done when:** ten consecutive calls, including three with a forced provider failure, all end cleanly with a stored transcript.

## S17 — Turn-taking and barge-in
*Size: 2 days.*

**Build**
- Roughly five seconds of silence hands the turn to Jarvis (transcript msg 15).
- **Barge-in**: Enrique speaking over Jarvis stops playback immediately and starts listening. Being talked over by your own assistant is the single most irritating failure in voice UX.
- Tune the endpointing so a natural pause mid-thought is not treated as the end of a turn.

**Test** Interrupt at the start, middle, and end of a long reply — playback stops within a beat each time. Pause three seconds mid-sentence and continue: Jarvis waits. Pause six: Jarvis takes the turn. Background noise and a TV playing do not trigger a turn.

**Debug** If barge-in is laggy the audio stream is being buffered before detection. Measure from the caller's first syllable to playback stop; anything over ~300 ms feels rude.

**Done when:** a two-minute natural conversation runs with no talking over each other in either direction.

## S18 — The desk actually does the work
*Size: 3 days. This is what makes calling useful rather than pleasant.*

Tier 1 keeps the line human; Tier 2 has every tool. Today Tier 2 answers.
It must **act**.

**Build**
- Tier 2 gets `task_create` and the rest of the Supervisor toolset, running after the caller has been acknowledged.
- The call carries context across turns — one conversation, not a series of unrelated questions.
- Tier 1 never claims something was done. It has no tools; its acknowledgements say "passing that to the desk", never "done".
- When the desk finishes, it reports on the channel Enrique prefers — and during a call, it can be spoken back mid-conversation if it lands in time.

**Test**
- Call and say "in Alpha, the login button is off-centre on mobile — fix it and open a PR." Hang up. A heavy task exists with the right project and a usable objective, and the PR link arrives afterwards.
- Ask a question needing a lookup: the answer is correct and cites what it came from.
- Confirm Tier 1 never says a thing was stored, created, or changed. Grep the transcripts for those claims as an actual test.
- Say two things about two projects in one call → two tasks, correct projects.

**Debug** If the desk is slow enough to be useless, check whether it is re-loading memory and the full tool schema on every turn. Tier 1's latency budget is the feature; Tier 2's is not, but minutes is not "not a budget".

**Done when:** a phone call produces a merged-ready PR without touching a keyboard.

## S19 — Jarvis calls Enrique
*Size: 2–3 days. Does not exist at all today — only the quiet-hours check does.*

**Build**
- Outbound dial through Telnyx, reusing the same call state machine and voice as inbound.
- The reasons it may call, and no others: a task blocked over an hour on something only Enrique can unblock; a production incident on a professional project; a destructive action awaiting approval past its window; a security or isolation event.
- **Quiet hours 19:30–08:00 America/New_York are enforced at the dial site**, not in the UI. Weekends are fine. A blocked call becomes a WhatsApp plus an Issue and retries at 08:00.
- It opens by saying who it is and why it is calling, in one sentence, before anything else.
- No answer → voicemail-safe behaviour, then fall back to WhatsApp. Never redial in a loop.

**Test**
- Trigger each of the four reasons and confirm a call for those and **only** those. A routine completion must never ring the phone.
- Set the clock to 20:00 → refused, WhatsApp + Issue instead, retried at 08:00 (L13).
- Saturday 10:00 → allowed.
- Decline the call → one WhatsApp, no redial loop.
- Answer it → the reason is stated in the first sentence.

**Debug** The commonest failure will be calling too often. Instrument the decision and review a week of it before trusting it; a Jarvis that cries wolf gets silenced permanently.

**Done when:** a genuinely blocked task rings the phone during the day and stays silent at 21:00.

## S20 — Voice memory and review
*Size: 1–2 days.*

**Build** Every call: recording (retention-classed like WhatsApp audio — 7 days, never past 10 unless marked permanent), transcript, summary, and any tasks it produced, all attached to a conversation and visible in the console.

**Test** Make a call, then find it in the console and read what was said and what it caused. Ask in a later call "what did I ask you about Alpha yesterday?" and get it right. Confirm the raw audio is gone at day 7 and the transcript remains (L12).

**Debug** If a call has no transcript afterwards, the artifact was written but never registered, or registered against the wrong project. Check `artifacts` by path. If retention deletes too early, the `retain_until` was computed at ingest from the wrong clock — verify against a call made just before a day boundary.

**Done when:** a call is as reviewable as a chat thread, and audio retention holds.

---

# STAGE 5 — MAKE IT REACH

## S21 — Shrink the model routing
*Size: 1 day. Do it early — it removes code every later step would otherwise inherit.*

**Build** Cut to what is real: Fireworks open-weights primary plus one fallback for the Supervisor; Claude Code on subscription for the engineer; Groq Whisper for STT; ElevenLabs for TTS. Delete the dead free-tier chain. Authentication stays per **provider**, never per model.

**Test** `/api/models` shows two healthy supervisor routes and no `discovered` row pretending to be routable. Kill the primary → failover, same conversation id, no metered enablement (L4). Add a second model on an existing provider → **no** new key requested.

**Debug** A route that looks healthy but never serves is usually failing its probe silently and being left `degraded` rather than dropped. Read `model_registry.last_error`. If a supposedly deleted provider still appears, something is re-seeding it on boot — grep the migrations and the catalog seeder before editing rows by hand.

**Done when:** every registered route has passed a real tool-enabled call.

## S22 — Project onboarding and `AGENTS.md`
*Size: 2–3 days. S5 reads this file; nothing currently writes it.*

**Build** Creating a project is a conversation. Jarvis asks and does not guess: personal or professional; production and customer-facing status; confidentiality; exact GitHub owner/repo or permission to create a private one; which auth profiles may see this data; metered paid APIs and the ceiling; deploy environments and approval rules; required tests, review, backups, monitoring.

On finalize it **writes `AGENTS.md` into the repository** from `docs/TEMPLATES.md` and versions it in `project_instructions_versions`.

**Test** Create a project by voice; the committed `AGENTS.md` matches the answers. Skip a required answer → it asks again rather than defaulting. Create a professional project → paid/subscription profiles only, and a free consumer endpoint is refused for its source code.

**Debug** If `AGENTS.md` lands with template placeholders still in it, finalize ran before every answer was collected — the onboarding session must refuse to finalize on a missing required field rather than substituting a default. If the committed file and the database disagree, decide which is canonical now and enforce it; two sources of project policy is a bug that gets worse with time.

**Done when:** a project created by voice ends with a correct committed `AGENTS.md`.

## S23 — Configuration by conversation
*Size: 2 days.*

Transcript msg 17: telling Jarvis to change how Jarvis works must work from
wherever Enrique happens to be, including about a project he is not currently
talking about.

**Build** "Stop doing X", "always do Y in project Z", "change Alpha's deploy
policy", "use this connection for Beta from now on" become **configuration
tasks**: interpreted, validated, versioned in `config_versions` and
`project_instructions_versions`, applied, audited, and reversible. They may
reach into any project's instructions, connections, schedules, model routing,
queue policy, and tool permissions.

What they may **never** touch without an explicit approval is the immutable list
(§59): isolation, authentication, audit, backups, spend ceilings, the
always-confirm list, secret scope, and the authority of the system projects.

**Test**
- A spoken instruction changes another project's `AGENTS.md`, and the change is versioned with the conversation that caused it.
- "What changed in Alpha's policy last week?" answers correctly from the version history.
- Roll a change back and confirm the previous version is restored exactly.
- An instruction that would weaken isolation or raise a spend ceiling → refused, approval raised, nothing applied.
- A garbled or ambiguous instruction → one clarifying question, no partial application. **A half-applied config change is worse than none.**

**Debug** If a change applies but does not show in history, the write is bypassing the versioning path. Every config write goes through one function; find the one that does not.

**Done when:** a sentence changes a different project's behaviour, is auditable a week later, and can be rolled back.

## S24 — The engineering evaluation suite
*Size: 3–4 days.*

Transcript msg 09: Jarvis runs its own quality testing and picks its primary and
backup models from the results. It does not take a vendor's word, and neither do
we.

**Build** A private benchmark built from issues already solved in these repos —
real bugs with known-good fixes. Every harness/model pair is scored on:
reproduction, root-cause accuracy, correctness, hidden tests, regression safety,
test quality, tool reliability, scope control, code quality, PR quality,
unnecessary escalation, and quota consumed.

Results land in `benchmarks`. A model **earns** the `senior_engineer` role by
winning the suite, and `route_order` follows from the scores rather than from
someone's opinion.

**Test**
- Run two harnesses through it and confirm the winner is what routing actually uses afterwards.
- Feed it a deliberately bad model and confirm it scores badly rather than passing on fluency — a suite that everything passes measures nothing.
- Re-run the same pair twice: scores should be close. Wild variance means the suite is measuring noise and needs more cases before anyone trusts it.

**Debug** If every candidate scores the same, the cases are too easy. Add cases from bugs that actually took real time to solve.

**Done when:** the `senior_engineer` route was chosen by measurement, and rerunning the suite reproduces the ranking.

## S25 — Memory and knowledge
*Size: 3–4 days.*

**Build** Everything Enrique dumps — documents, pasted logs, transcripts, forwarded threads — chunked, indexed, searchable forever. Scoped per project with a global tier for Supervisor memory. Answers cite their source.

Decide and record the retrieval architecture in an ADR: embeddings local or hosted, which model, and how it obeys the RAM policy (embeddings never run while heavy work is active). This is the one genuinely open architectural question left.

**Test** N2: dump a long thread and three PDFs, ask a specific question three weeks later (clock-shifted), get a cited answer. Survive a reboot. Ask about project A and confirm project B's documents are not in the answer.

**Debug** Wrong or missing answers are usually retrieval, not the model: log what chunks were retrieved before blaming the reply. If chunks from another project appear, that is an isolation bug and stops other work. If recall is poor across a reboot, check the index survived — an in-memory index that silently rebuilds empty answers confidently and wrongly.

**Done when:** N2 passes across a restart with correct citations and no cross-project leakage.

## S26 — Composio and MCP
*Size: 4–5 days. After S5, so there is something to use them.*

**Build** The Composio adapter, so any Composio-supported service is reachable under project scope through the broker. Then a generic MCP client: attach any MCP server, scoped to a project, tools surfaced to the harness. Untrusted servers run in Docker, never on the host.

**Test** A project-scoped Composio connection used by a heavy task; the same connection denied to a second project. An MCP server attached to one project and invisible to another. A deliberately hostile MCP server cannot escape its container or read another project.

**Debug** A Composio call that works for one project and fails for another is the broker doing its job — confirm the denial is deliberate before treating it as a bug. An MCP server that hangs takes the heavy lane with it: every MCP invocation needs a timeout, and a server that times out twice gets disabled with an Issue rather than retried forever.

**Done when:** a heavy task completes real work through a Composio connection, and cross-project access is denied and audited.

## S27 — Browser and scraping
*Size: 4–5 days. Named in the very first planning message and still at zero.*

**Build** Project-scoped browser profiles (never shared), headless control, and a scraping toolkit good enough for real sites — retries, rate limiting, honest user agents, structured extraction. Write the ADR first; this has never been designed.

**Test** Scrape a real site and file the result as a project artifact. Confirm project A's browser profile and cookies are unreachable from project B. Kill the browser mid-scrape → recovers or fails cleanly, never hangs the heavy lane. Run it under the RAM policy with the browser occupying the heavy slot.

**Debug** Scraping failures are rarely code. Capture the actual response body and status before changing selectors — a block page, a consent wall, and a rate limit all render as 'the selector broke'. If memory climbs across runs the browser is not being closed on the error path. Keep one saved copy of each page shape that broke, because the site will change again.

**Done when:** a scraping task completes unattended and its output lands as a project artifact.

---

# STAGE 6 — MAKE IT SURVIVE

## S28 — Notification policy
*Size: 2 days.*

**Build** §17 exactly: silence on trivial capture; one line on short work; ack-plus-result on long work; one message per blocker with a working link; the weekly report. A repeated condition is a counter, not another page.

**Test** L10 — a trivial capture produces **zero** messages; a long task produces exactly two. Ten identical failures produce one notification with a count of ten. Every link in every notification actually opens the right page.

**Debug** If notifications arrive that should not, log the classification decision alongside the message and read a day of it — the bug is nearly always in classification, not in delivery. If they do not arrive at all, check the outbox state before the transport: a message stuck `pending` and a message that failed to send look identical from the phone.

**Done when:** a day of normal use produces only messages worth reading.

## S29 — Schedules, maintenance, improvement
*Size: 3 days.*

**Build** Schedules with overlap policy and misfire handling. The Maintenance project repairing what is safe and reversible and filing an Issue for the rest. The weekly Improvement scan (transcript msg 17) with one-tap approvals.

**Test** L14: overlap skipped, misfire >15 min skipped with an Issue, three errors pause the schedule, restart causes no duplicate fire. L19: simulate disk at 85%, an expired credential, a missed backup and a stuck browser — safe repairs happen, the rest become Issues, none of it wakes Enrique (N7). Force an Improvement run and confirm nothing activates itself.

**Debug** A duplicate fire after a restart means idempotency is keyed on something other than `scheduled_for`. A schedule that silently stops has usually hit its error count and paused itself — that is correct behaviour, but it must be visible in the console rather than only in a column. For Maintenance, confirm each auto-repair wrote what it did; a repair with no audit row is indistinguishable from a bug that fixed itself.

**Done when:** the system runs a full week unattended and the only messages are ones worth reading.

## S30 — Backup, restore, export
*Size: 2–3 days.*

**Build** Restic to B2 nightly including the database dump. Monthly restore drill recorded where the console can see it. One-command encrypted export of everything — schema, rows, artifacts, re-encryptable credentials, model registry, config, OpenClaw session — and a documented restore elsewhere.

**Test** L15: restore into a clean directory and verify projects, conversations, tasks, issues, schedules, a decrypted canary credential, and the model registry. **Then restore onto a different machine and boot it** — that is the transferability Enrique asked for in his first message, and a restore that has only ever been tested in place has not been tested.

**Debug** v1's backups did not contain the database and it went unnoticed. Assert on the dump's size and on a known row, not on the exit code.

**Done when:** a full restore runs on a second machine and Jarvis comes up with its memory intact.

## S31 — Full acceptance
*Size: 2 days.*

**Build** Nothing new. Run every gate in Part VIII, fix what fails, and freeze.

**Test** All five gates. Every narrative N1–N8. Every critical loop.

**Debug** A gate that passes on the fake harness and fails on the real one is the most likely outcome here, and it is information rather than a setback — the difference is exactly the assumptions the fake encoded. Record each one in `docs/DEBUG_NOTES.md` as you find it.

**Done when:** all gates green, with N1 green **against the real harness**, not the fake one.

---

# STAGE 7 — THE LAST THING

## S32 — WhatsApp
*Size: 2–3 days. Deliberately last. The number connects tomorrow; build everything up to the pairing now.*

When S31 is done, this is the only work left between here and a finished Jarvis.

**Build now, before the number exists**
- The bridge already persists first and blocks OpenClaw's default agent. Verify that end of it against the local stack.
- Ingest for every payload type: text, **voice notes**, images, documents, forwarded messages.
- **Voice notes are the priority** — that is how Enrique will mostly use it. Audio → artifact (`retention_class='raw_audio'`) → Groq Whisper → transcript message linked to the original → routed exactly like typed text. The whole path is testable today by posting the same payload shape to the ingest endpoint; it does not need a paired number.
- Reconciliation that backfills anything missed while the API was down.
- Retention: raw audio 7 days, never past 10 unless marked permanent.

**Test before the number exists** — everything except pairing:
- Synthesised inbound payloads of each type against `/internal/inbox/ingest` → correct inbox events, artifacts, transcripts and routing.
- A real audio file through the full transcribe-and-route path.
- Kill the API for 10 seconds mid-send → the bridge retries, reconciliation fills the gap, nothing is dropped (L1).
- Ingest with a bad HMAC → refused.
- An unknown sender → ignored, not processed.

**Test after pairing (tomorrow)**
- QR pair the dedicated number. Send a text, a voice note, an image and a document from Enrique's phone.
- Two voice notes ten seconds apart about two projects → two threads, two tasks (N3).
- The full N1: voice note in, PR link back.

**Debug**
- If OpenClaw answers with its own agent, the plugin failed to load — it must stay plain JavaScript, no type annotations.
- Missing `INTERNAL_HMAC` makes the bridge refuse to complete. That is correct behaviour, not a bug.

**Done when:** N1 runs end to end from a voice note on Enrique's phone. **That is the finish line for this plan.**


---

# PART IV — SHARED CONTRACTS

Frozen. These are the invariants every step is built against. Changing one is
its own commit, never bundled into feature work — a schema or taxonomy change
smuggled inside a feature is how a whole stage becomes unrevertable.

## IV.1 Schema
37 tables, already migrated. The task table already carries `worktree_path`,
`branch`, `head_sha`, `harness`, `external_session_id`, `auth_profile_id` — the
data model anticipated the executor even though the code never arrived. New columns get the next migration number and a note in the commit saying what
depends on them. **Never edit an applied migration** — it has already run on the
box, and `schema_migrations` will not re-run it, so the file and the live schema
silently diverge. Always add a new one.

## IV.2 Task and issue state machines
As in `docs/STATE_MACHINES.md`. Illegal transitions are a 409 plus an audit row.

## IV.3 Error taxonomy
As in `docs/ERROR_TAXONOMY.md`: every failure class maps to severity, whether a
retry can help, a retry limit, and a notification level. A new class is a deliberate
addition to the taxonomy, with its severity, retryability, limit and notify level
chosen on purpose — never a string invented at a call site, which is how a
failure ends up silent.

## IV.4 Credential broker
Check order: connection exists → project allowlist → role allowlist →
confidentiality policy → spend policy → always-confirm gate. Fails closed. Every
denial is audited. Secrets are decrypted at point of use and never logged.

## IV.5 Events
SSE names are a closed set: `health`, `task.updated`, `queue.updated`,
`issue.updated`, `approval.updated`, `conversation.message`, `heartbeat`. Adding one
means updating the union in `sse.ts`, `docs/API_AND_EVENTS.md`, and the console
together — a new event name that only one of the three knows about is a feature
that works on your machine and nowhere else.

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

Jarvis is a production system for one user, and that user is also its only
operator. There is nobody to catch a bad deploy.

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

Jarvis is not finished until every gate is green. v1 shipped 33 of 33 passing
while the machine did nothing, so Gate 1 blocks all the others and N1 is what
closes it.

## VIII.0 The four layers of testing

Every step in Part III tests at whichever of these layers actually proves the
thing. Naming them here stops "I ran it once" from passing as coverage.

| Layer | What it covers | Runs |
|---|---|---|
| **Unit** | Pure logic: cron matching, backoff curves, redaction, state-transition legality, taxonomy mapping | Every commit, seconds |
| **Integration** | Real Postgres, real HTTP, **fake harness**. Claiming, leases, checkpoints, recovery, the broker, the whole engineering loop | Every commit, minutes |
| **Acceptance** | `scripts/acceptance-runner.py` against a running stack — the L-loops and the N-narratives | Before every merge to main |
| **Manual** | Anything with a human in it: a phone call, a voice note, a page on a real phone | Before closing a stage |

The fake harness (S1) is what makes the integration layer possible at all. Without
it the engineering loop is only testable by hand, against a paid subscription,
on Linux — which is why v1's never was.

**CI runs unit and integration on every push.** Acceptance runs against a live
stack. Manual is checklisted per stage and its evidence goes in the commit.

## Gate 1 — It acts *(blocks everything else)*
- **N1** the fix, end to end — console first, then voice note at S32
- **S7** seeded failing test → passing PR, in the suite and proven able to go red
- **L0b** the happy engineering loop
- **S1's five harness variants** each producing the right taxonomy class

## Gate 2 — It loses nothing
- **L1** capture while busy, including a 10-second API kill mid-send
- **L2** queue survives process restart and a full reboot, order preserved
- **L3** killed harness recovers from its checkpoint, same worktree
- **N3** two things at once, two threads, two tasks, neither lost
- Five distinct mid-run failures (S10) each resumable

## Gate 3 — It stays inside its lines
- **L6** two repos, distinct deploy-key fingerprints
- **L9** cross-project probe denied and audited
- **L11** auth-profile isolation, denied before any HTTP leaves the box
- **L8** always-confirm blocked
- **N6** production deploy refused without a live approval
- All eight grant-invalidation conditions (S9) verified individually

## Gate 4 — It is usable
- **N4** credential loop repaired from a phone, parked task resumes itself
- **L17** the six mobile journeys
- **S12** the console leads with work, not health
- **L10** notification brevity: zero messages for trivial capture, exactly two for a long task

## Gate 5 — The phone is dependable
- Ten consecutive calls, three with a forced provider failure, all ending cleanly with a stored transcript
- The two historical bugs — self-transcription and the runaway recording loop — covered by permanent regression tests
- Barge-in stops playback within a beat, at any point in a reply
- A call produces a real task and a real PR (S18)
- **L13** outbound refused at 20:00 and allowed Saturday 10:00; the four calling reasons trigger, and nothing else does
- **L12** raw call audio gone at 7 days, transcript retained

## Gate 6 — It survives
- **L15** restore drill, **and** a restore onto a second machine that boots
- **L4** model failover with no metered enablement
- **L14** schedules: no duplicate fires across a restart
- **N7** self-repair at 03:00 without waking him
- **N2** a question answered weeks later with a citation, across a reboot
- **N8** the weekly report arrives and activates nothing on its own

## The standing rules

1. **No test passes by asserting a database row where it should assert an effect.** If it does not prove something changed in the world, it does not count.
2. **Every test must have been seen to fail once.** Break the thing deliberately, watch it go red, then fix it. An assertion that cannot fail is decoration.
3. **A gate closes only with evidence attached** — a transcript, a task id, a log excerpt, a screenshot. "I checked" is not evidence.

---

# PART IX — HOW TO WORK

One agent, thirty steps, in order. This part is the discipline that keeps that
honest.

## IX.1 The loop for every step

Read the step. Build it. **Test it, including the failure paths.** Debug until
the "Done when" line is observed. Commit with the evidence in the message. Then,
and only then, read the next step.

Do not batch steps. Do not start S5 because S4 is "basically done". Basically
done is how v1 accumulated a chassis with no engine.

## IX.2 The test discipline

This is the part of the plan that matters most, because it is the part v1 skipped.

**What counts as tested**
- The happy path was **observed**, not inferred from a green typecheck.
- At least one failure path was forced and behaved as the taxonomy says.
- The evidence — a transcript, a task id, a screenshot, a log excerpt — is in the commit message or an artifact.

**What does not count**
- `tsc` passing.
- The code "looking right".
- A test asserting that a database row exists where it should assert that something happened in the world.
- A test that has never been seen to fail. Break the thing deliberately once and watch it go red. An assertion that cannot fail is decoration.

**The four questions before calling a step done**
1. Did I watch it work, or am I assuming?
2. What happens when the network, the provider, the disk, or the process dies mid-way?
3. What happens with empty input, and with far more input than expected?
4. If this breaks in three weeks, what evidence will exist to debug it?

**Test order within a step:** failure paths first where practical. They are
where the bugs are, and building the happy path first tends to bake in
assumptions that the failure paths then have to fight.

**Regression tests are permanent.** Every bug found the expensive way becomes a
test before the fix is committed. The call agent's self-transcription bug and
runaway-recording loop are the model: both cost real time, both are now one-line
comments, and both should have been tests.

## IX.3 The development environment

S1 exists so that no later step has to be built blind. After S1:

- `docker compose -f deploy/compose.dev.yaml up` gives Postgres and the API with migrations applied and a seeded operator.
- `JARVIS_ROOT` points at a scratch directory; no dev box needs `/var/lib/jarvis`.
- `JARVIS_HARNESS=fake` runs the whole engineering loop with no subscription, no network, and no Claude CLI. Variants `fake:slow`, `fake:crash`, `fake:runaway`, `fake:noop`, `fake:escape` exercise every failure branch deterministically.
- `scripts/dev-seed.ts` resets to a known state.

**Windows is not a target for the runner.** It spawns POSIX processes and sets
unix permissions. Use WSL, a container, or the box itself. A green `tsc` on
Windows is not a tested change.

## IX.4 Debugging on the live box

- **Read the evidence before forming a hypothesis.** `journalctl -u jarvis-runner -f`, `docker compose logs -f api worker`, and the `task_transitions` table for a given task id will answer most questions faster than reasoning about the code.
- **The database is the source of truth**, not the assistant's own account of what it did. When a tool "worked", query the table.
- **Capture raw payloads once** for anything whose shape you are guessing at — `stream-json` events, Telnyx webhooks, provider error bodies. Read the capture; do not infer the shape.
- **A bare status code is not a diagnosis.** The v1 model-routing failure took far longer than it should have because only the code was stored and not the provider's error body. Store bodies.
- **When stuck for more than an hour, write down what you observed** in `docs/DEBUG_NOTES.md` before trying anything else. Half the value is in noticing that the observations contradict the hypothesis.

## IX.5 When to stop and ask Enrique

Stop for: anything touching isolation, billing, production permissions, or the
always-confirm list; a decision that changes what the product *is*; a step that
has failed three times for different reasons, which usually means the step is
wrong rather than the code.

Do not stop for: which library, how to structure a module, what to name things,
or whether to write a test. Those are yours.

## IX.6 What not to do

- **Do not work on the frozen ops layer.** Error taxonomy, notification outbox, quiet-hours plumbing, backups, host metrics, health incidents, ADR conformance sweeps. They are finished and good. Every hour there is an hour Jarvis still cannot open a PR. This is the single trap that consumed v1's overnight run of 31 ticks.
- **Do not add features not in this document.** If the gap is real, write an ADR.
- **Do not mark a step done because a row was written.** Done means the effect happened.
- **Do not point an autonomous loop at the acceptance suite until S7 exists.** A loop optimises what the suite measures; before S7 the suite measures plumbing.
- **Do not refactor across steps.** A refactor spanning half-finished work is unreviewable and unrevertable.

## IX.7 The work already in flight

There is uncommitted work in the tree — `callagent.ts` plus edits to
`supervisor.ts`, `catalog.ts`, `callcontrol.ts` and `product.ts` — building the
two-tier phone agent. That is real progress on Stage 4 and it should be committed
on its own branch before anything else touches those files, not left loose in a
shared working tree.

---

# PART X — THE ROAD

| Stage | Steps | What it buys | Rough |
|---|---|---|---|
| **1 — It acts** | S1–S7 | A sentence becomes a pull request. **The only stage that is not optional.** | 9–11 days |
| **2 — It is trustworthy** | S8–S11 | Review, grants, recovery, proven isolation | 7–8 days |
| **3 — It is visible** | S12–S15 | A console that shows work and repairs credentials | 8–10 days |
| **4 — The phone is reliable** | S16–S20 | A call you can depend on, and Jarvis calling you | 10–12 days |
| **5 — It reaches** | S21–S27 | Routing, onboarding, config-by-voice, model evals, memory, Composio, MCP, scraping | 19–24 days |
| **6 — It survives** | S28–S31 | Notifications, schedules, self-repair, restore, acceptance | 9–11 days |
| **7 — WhatsApp** | S32 | The last thing. Voice note in, PR back. | 2–3 days |

**Total: roughly 65–80 working days** for one agent working sequentially, with
testing done properly at every step rather than deferred.

That number is honest rather than encouraging. Two things make it smaller:
Stage 1 alone is already a usable Jarvis for engineering work, and Stages 3–6
are each independently shippable — none of them has to be finished before the
system is useful.

## The order is not arbitrary

- **S1 first** because every step after it is tested through the fake harness. Building it later means everything before it was built blind, which is exactly how the runner came to be written and never run.
- **S2 and S3 next** because they are the critical path. Until a message can become a task and a task can spawn a harness, no other work can be demonstrated at all.
- **Stage 2 before Stage 3** because a console showing untrustworthy work is worse than no console.
- **Stage 4 after Stage 1** because the phone becomes genuinely useful only once the desk can *do* something. A reliable call to a system that cannot act is a pleasant dead end.
- **S32 last** by request: the number connects tomorrow, and everything up to the pairing is built and tested before then.

## What "finished" means

When S32 is green, this is true:

> Enrique sends a voice note. Minutes later he gets one short message with a link
> to a pull request that fixes what he described. He can call Jarvis and talk to
> it, and it can call him when something genuinely needs him. Everything he has
> ever dumped on it is searchable. It repairs itself, backs itself up, and can be
> moved to another machine. Nothing he says is ever lost.

There is no Stage 8. That is the product.

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
| Phone calls, both directions (06, 07, 15) | S16–S20 |
| Jarvis can call me (06, 15) | S19 |
| Five-second turn-taking on calls (01) | S17 |
| WhatsApp voice notes (01, 15) | S32 |
| Nothing I say is ever lost (15) | S2, S10, S32, Gate 2 |
| Testing, trying, debugging built in | III.0, IX.2, IX.4, every step |
| Jarvis tests models and picks its own primaries (09) | S24 |
| Change any project's setup from any channel (17) | S23 |
| Weekly scan of the AI world, one-tap approve (17) | S29 |
| Maintenance project that heals the system (17) | S29 |
| Dump anything, ask about it later (01) | S25, N2 |
| Never mix connections between projects (01, 20) | S4, S11, S26 |

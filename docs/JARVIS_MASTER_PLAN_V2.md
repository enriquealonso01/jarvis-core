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

## 0.45 What V1 deliberately is not

Listed because an eager builder will otherwise add several of these, each
defensible on its own, and together they are how a focused system becomes a
sprawling one. None of them ship unless implementation reveals a compelling need
and an ADR records it:

- Multiple human users, public registration, team roles, social login. **One user. Build session auth and project isolation, not an identity system.**
- Complex customisable dashboards, a theme marketplace, multiple polished visual themes. One good theme, dark and light, done properly.
- Netlify or Supabase holding authoritative data. Postgres on the box is the source of truth.
- Any browser-side access to OpenClaw administrative credentials.
- Hidden chain-of-thought display. Show what it *did* — tools, phases, outputs — never a performance of what it was thinking.
- **Fake progress indicators.** A bar that moves because time passed rather than because work completed is a lie with a nice animation. This binds the S13b build progress bar: every segment of it must correspond to something that actually happened.
- Any workflow that requires Enrique to SSH into the box to add a normal credential or connection. If a routine action needs a terminal, that action is not finished.
- Web push notifications. WhatsApp is the pager.

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

**Built and executed against a fake harness (S1 done, 2026-09-01)**
- `src/runner.ts` — claims heavy tasks, cuts a worktree, spawns the harness, streams a transcript, heartbeats, honours cancel/silence/timeout. Now runs end to end in `deploy/compose.dev.yaml` against `scripts/fake-harness.mjs`: all six variants observed (`ok`, `crash`, `slow`, `runaway`, `noop`, `escape`). It has still never met the real `claude` binary — that is S3, and the `stream-json` shapes should be captured raw before the parser is trusted.

**Exists as an endpoint, unreachable by Jarvis**
- `src/github.ts` — create repo, provision deploy key, open PR, merge PR. All four work, all four are behind `requireUser`, so only a human clicking a button can call them. They are not Supervisor tools and nothing pushes a branch for them to open a PR against. S5 and S7 wire them up.

**Exists as a page, degraded**
- The Control Center has every route it needs. It leads with health because health was all there was, and several pages bind to fields that no longer exist. S13–S15 repair it rather than restart it.

**Does not exist at all**
- Any way for a message to become work (`task_create`) — S2.
- Outbound calling. Only the quiet-hours *check* exists; nothing dials — S23.
- `packages/integrations` — an empty README where Composio, MCP adapters, and HTTP adapters should be — S31.
- Browser control and scraping — S32.
- Project onboarding and `AGENTS.md` authoring — S26.
- Memory retrieval over dumped documents — S30.
- Any test that asserts Jarvis did a piece of work — S8.
- Any way to run the engineering loop without a paid subscription and a Linux box — S1.

**Carrying weight for a dead constraint**
The free-tier model chain. Migration 008 measured it: the nominal primary served
9 turns of 153 and Gemini served 0. Fireworks is a paid route now. A large part
of `catalog.ts` exists to survive a constraint that no longer applies — S25
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

**How a turn actually goes.** He asks something. Within a beat Jarvis
acknowledges — differently each time, naming the thing so he knows it was heard.
If the answer needs a lookup it says so, goes and does it while the line stays
alive, and comes back. If it is taking real time it says something new rather
than repeating itself. If it is going to take longer than a conversation should,
it hands the work to the queue and says so plainly.

**Fast and shallow beats slow and deep, on the phone, always.** The call is a
conversation and a capture surface — not where deep work happens. Every word is
recorded and routed regardless, so the main Jarvis system picks up anything real
afterwards. That safety net is what allows the phone to be quick: nothing is lost
by a shallow answer.

**Two-tier answering** — already built; a latency architecture, not a feature:
- **Tier 1 — the voice.** No tools, reasoning off, one short reply, sub-second. Its only decision is *answer* or *hand over*. Because it has no tools it must never claim anything was done.
- **Tier 2 — the desk.** The full Supervisor with every tool, running after the caller has already been answered. It does the actual work and reports back on the channel Enrique prefers.

**When Jarvis calls, unprompted.** Rare by design, and only for six things: a
task blocked over an hour on something only Enrique can unblock; a production
incident on a professional project; a destructive action awaiting approval past
its window; a security or isolation event; **a call he scheduled**; and a
monitoring rule he explicitly authorised to call. Anything else waits for
WhatsApp.

Inside quiet hours it does not call at all — a blocked call becomes a WhatsApp
plus an Issue and retries at 08:00 — with one narrow exception: a confirmed
security incident or active data loss. A production outage at 3am does not
qualify. The full rule and its rationale are in S23.

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

### Visual direction

It should feel like an exceptionally polished operations console — closer to a
professional cloud platform than a movie prop, while still being recognisably
Jarvis.

- Dark graphite background, slightly lighter elevated panels.
- Restrained cyan or cool blue as the accent. Restrained is the operative word.
- **Colour carries meaning, and only that meaning.** Green is healthy or succeeded. Amber is a warning or something needing attention. Red is an incident, a destructive operation, or a serious failure. Purple identifies Jarvis Improvement activity. A colour used decoratively is a colour that no longer means anything.
- Clean sans-serif throughout. **Monospace only** for logs, commands, IDs, branches, SHAs and technical values — where character-level precision matters and proportional type actively hurts.
- Subtle animation for live state changes, so something arriving is noticeable without being theatrical.

And explicitly not:

- glowing borders everywhere
- moving backgrounds
- decorative gauges that communicate nothing
- a fake holographic interface

The semantic-colour rule above and the **no-information-by-colour-alone** rule in
S15 are complements, not a contradiction: colour must mean the same thing
everywhere, *and* never be the only thing carrying that meaning. Green plus a
tick, amber plus a word.

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

## II.2b The harness is disposable

Jarvis is not its harness, its models, or its providers. Every one of those is a
replaceable part behind an interface, and the plan is built so that replacing any
of them is a configuration change rather than a rewrite:

| Part | Interface | Swap cost |
|---|---|---|
| Coding harness | `AgentRuntime` (S28) | a new implementation + a registry row |
| Chat model | `model_registry` route | a URL and a key |
| Provider | auth profile | a key, because the weights are open (VI.0) |
| Channel | inbox event | a new ingest adapter |

This is what makes "eventually I will buy a machine and run everything myself"
a configuration change rather than a second project. It is also the reason the
free-tier collapse cost a migration and not a rebuild.

The rule that keeps it true: **no vendor name appears outside the adapter that
owns it.** A `claude`-specific branch in the queue, the console, or the broker is
the abstraction failing quietly.

## II.2c Do not rebuild what OpenClaw already does

A principle discovered late in planning and worth stating plainly: **do not build
a parallel replacement for capabilities OpenClaw already implements reliably.**

OpenClaw owns the WhatsApp session, device pairing, and transport-level retry.
Jarvis owns the product brain — inbox, projects, queue, issues, broker, console.
The temptation, every time OpenClaw does something slightly differently from how
we would, is to reimplement it. Resist it: a second implementation of session
handling is a second thing to debug at 2am, and the one we did not write is the
one that has been tested by other people.

The line: **if it is transport, OpenClaw owns it. If it is a decision, Jarvis
owns it.** Where that line is unclear, write it down in an ADR rather than
building both sides.

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

### Liveness is not progress

A heartbeat proves a process is **alive**. It does not prove it is **working**,
and the difference is where stuck agents hide. `npm install` wedged on a network
call heartbeats happily for an hour.

So the watchdog reads two signals, not one:

- **Heartbeat** — the process exists and its loop is turning.
- **Progress events** — it did something: opened the repository, ran the tests, modified a file, called a tool. Every worker emits these as it goes.

The discrimination that matters is between these two:

> *"pytest is legitimately running for six minutes."*
> *"The agent has been doing absolutely nothing for six minutes."*

They look identical from the agent's progress stream — a test suite emits no
agent events either. So the tie-breaker is the **child process**: a spawned
command burning CPU or waiting on the network is legitimate work, and the
watchdog waits. No agent progress *and* no working child is stuck.

This corrects the simpler rule of "alive with no progress is stuck", which would
have killed every long test run on the box.

The watchdog therefore reads: worker heartbeat, agent progress events, CPU and
memory, child-process state, browser state, harness state, task duration,
**repeated identical actions** (`agent.repeat`), tool errors, network waits, and
queue health.

### The recovery ladder

Recovery escalates from cheapest to most expensive, and stops at the first rung
that works. Jumping straight to a worker restart turns a two-second network blip
into a lost quarter-hour:

1. **Wait** — most stalls resolve themselves.
2. **Nudge** — re-prompt the agent with its own last progress event.
3. **Retry** the failed operation.
4. **Reset** the tool or browser.
5. **Restart the worker.**
6. **Restart the coding session.**
7. **Resume from checkpoint** with a fresh worker.
8. **Switch model** within the approved pool.
9. **Switch harness** (S28's runtime interface is what makes this possible).
10. **Ask Enrique.**

Every rung is recorded on the task, so the timeline shows what was tried rather
than a bare "recovered". Each rung has its own limit and backoff — **repeated
failure must never become an infinite retry loop**, and a ladder without limits
is exactly how one is built.

Rungs 8 and 9 are the interesting ones: they mean a task blocked by a *model's*
inability rather than a *system* fault can still finish. That is only available
because models and harnesses are both replaceable parts (II.2b).

`running → stalled → recovering → running`, each step written down and visible in
the console. **The task never disappears.**

### What a checkpoint must contain

Checkpointing is what makes recovery useful rather than merely tidy, and a
checkpoint that only records *where* a run got to forces the next worker to
re-derive *why*. For an engineering task it carries:

`objective` · `conversation context` · `current plan` · `branch` · `commit SHA` ·
`files modified` · `commands executed` · `test results` · **`current hypothesis`** ·
**`next intended action`** · `artifacts`

The last two are the ones normally omitted and the ones that matter most. Without
them a resuming worker restarts the investigation from the beginning, which looks
like recovery and costs like a rerun.

Some reasoning is lost when a worker dies. **The task, and every instruction
Enrique gave it, are not.**

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

**Enrique's reordering always wins.** A manual reprioritise in the console beats
every rule above it, including the starvation cap. He does not have to argue with
the scheduler.

### The queue is a thing he can see

Not a Redis list hidden in the backend. The running item shows its project,
objective, **elapsed time** and **current phase** (`engineering → testing`); each
queued item shows its project, objective and **when it was added**. Position is
meaningful and visible, because a queue you cannot see is indistinguishable from
a system that lost your request.

### Conservative scheduling in V1, deliberately

The default is **FIFO-ish**: priority and the starvation cap shape it, and
nothing else does.

There is an obvious next move — while task #1 sits in a ten-minute test suite,
do lightweight prep for #2 rather than let the box idle. **That is explicitly not
V1.** Opportunistic scheduling makes failures much harder to reason about: two
tasks touching the box at once turns "which one broke it" into a question, and
the whole recovery story in II.3 assumes it is answerable.

Recorded here so it is neither invented early nor forgotten later. It needs an
ADR, a measured idle-RAM figure, and the recovery semantics worked out first.

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

One agent. One step at a time. Thirty-seven steps, in order.

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

## S3 — Routing what Enrique says
*Size: 3–4 days. This is the step that makes S2 usable rather than a tool nobody calls correctly.*

`task_create` gives Jarvis the ability to make work. This step is the judgement
about **when**, **where**, and **into what**. Three behaviours, all from the
planning conversation, all currently absent.

### 3a — Intent classification

Every inbound item is one of: **capture** (remember this), **question** (answer
it), **work** (do it), **instruction** (change how you behave), or **ambiguous**.
Route to memory, an answer, a task, a config task, or one short question.

Over-creating tasks is as broken as creating none. "Remember the client prefers
Tuesdays" is not a task.

### 3b — One input, several projects

Enrique does not send tidy single-topic messages. A five-minute voice note says:
*"TicketFlipping needs X… also for AIDP I thought of Y… oh, and next month we
should Z."* That is one inbox event and **three** destinations — two projects and
a scheduled reminder.

```
VOICE NOTE #9381
   ├── TicketFlipping  → conversation + task
   ├── AIDP            → conversation + task
   └── Personal        → scheduled task
```

The original audio and transcript stay attached to the **original** inbox event.
Splitting never destroys the source, and every derived conversation carries
`origin_inbox_id` back to it.

This is not an edge case. It is how he actually communicates, and a system that
handles only single-topic messages will silently drop two thirds of a long one.

### 3c — Feedback while a task is running

He is watching a task and types: *"Also check whether this could affect the CSV
export."*

- **Save the message immediately.** Before any classification, before any model. It is his input and it is now durable.
- **Then decide what it modifies.** If it belongs to the **running** task, attach it as new task context and signal the worker that context is available. If it belongs to a **different** task, create or update that queued task instead.
- **Nothing interrupts incorrectly. Nothing disappears.**

The worker picks up new context at its next checkpoint rather than being killed
and restarted — a mid-flight interruption loses the work already done.

### Build
- A classifier producing an explicit route decision, logged on the inbox event so a wrong route can be diagnosed later.
- Multi-destination splitting with `origin_inbox_id` provenance on every derived conversation and task.
- A `task_context` path: append to a running task, signal the worker, and have the runner read pending context at each checkpoint boundary.
- Ambiguity produces **one** short question, never a guess and never silence.

### Test
- **The five-minute memo.** One voice note naming three projects → three destinations, correct projects, one source artifact, provenance on all three. This is the headline test for this step.
- A memo naming a project that does not exist → asks, does not invent a project.
- "Remember X" → memory, no task. "Fix X" → task. "Always do X" → config task. "What is X?" → answer.
- **Mid-run feedback**: with a task running, send context that belongs to it → attached, worker sees it at the next checkpoint, the run is not restarted. Then send context that belongs to a *different* task → queued there, running task untouched.
- Send feedback in the second before a task completes → it lands somewhere retrievable rather than vanishing into a finished task.
- Three messages in ten seconds about three projects → three tasks, none merged, none lost.

### Debug
Wrong routing is the failure mode here, and it is invisible unless you log the
decision. **Record the classifier's verdict and its reasoning on the inbox
event**, then read a day of them — the bug is almost always one category
swallowing another (usually "work" swallowing "capture").

If splitting drops a segment, log the segmentation before the routing; a
three-way split that produced two destinations failed at the split, not the
route.

If mid-run context never reaches the worker, check the checkpoint boundary — the
runner must look for pending context, not be told. A push-based signal to a
process that is mid-harness-call has nowhere to land.

**Done when:** a single long voice note produces correctly-scoped work in three
places with the source intact, and feedback typed during a run reaches that run
without restarting it.

## S4 — The runner, live on real hardware
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

## S5 — Project checkouts and deploy keys
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

## S6 — The engineering workflow
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

## S7 — The pull request
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

## S8 — The acceptance test that matters
*Size: half a day. Do it the day S6 and S7 land.*

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

## S9 — Independent review
*Size: 2 days.*

**Build** A second model — different family where policy allows — reviews the diff before the PR opens. Findings and responses attach to the task; valid findings are addressed and verification re-runs.

**Test** Plant a flawed change (off-by-one, dropped null check, a test asserting nothing) and confirm review catches it. Then submit a *correct* change and confirm review does not invent problems — a reviewer that always finds something is noise that will be ignored within a week.

**Debug** If review always passes, check it is receiving the diff and not an empty string.

**Done when:** a planted bug is caught and corrected before the PR exists, and a clean change passes without invented findings.

## S10 — Grants, merge, deploy
*Size: 2–3 days.*

**Build** Task grants per IV.6 with all eight invalidation conditions. Merge and deploy broker-gated. Production on professional projects needs a live approval and defaults off.

**Test** Each of the eight invalidation conditions **individually**. "Fix it, PR it, merge it" on non-production personal → merges with no second click. Amend the commit after tests → grant invalidated, approval raised (L7). Production on a professional project → refused (N6).

**Debug** A grant surviving a SHA change means it is bound to the task rather than the commit. Check what is actually stored.

**Done when:** all eight conditions verified one by one, and N6 refuses.

## S11 — Recovery under failure
*Size: 2 days.*

**Build** Map every harness failure onto the taxonomy: subscription limit → `provider.cred_expired`, park and notify; silence → `process.stuck`; run limit → `agent.loop`; dirty exit → `harness.crash`. Retry within taxonomy limits, resume from checkpoint, never from the start.

**Test** Mid-run: kill the harness (L3); reboot the box; fill the disk; revoke the credential; sever the network. Each must produce the right class, the right notification, and a resumable task. Restart API and worker with three tasks queued and one running (L2) — order preserved, nothing lost.

**Debug** A task restarting from the beginning means checkpoints are written but not read. Look at the resume path, not the write path.

**Done when:** five distinct mid-run failures each recover correctly and none loses work.

## S12 — Isolation, proved
*Size: 1 day.*

**Build** Nothing new. This step exists to *prove* what earlier steps claimed.

**Test** Cross-project probe for files, secrets, browser dir, connection name, model profile — each → 403 + audit + `security.isolation` (L9). A project-owned auth profile used by the Supervisor → denied before any HTTP leaves the box (L11). Always-confirm actions blocked (L8).

**Debug** Any probe that succeeds stops all other work until it is closed.

**Done when:** L8, L9 and L11 all pass.

---

# STAGE 3 — MAKE IT VISIBLE

## S13 — The console leads with work
*Size: half a day.*

**Build** Home shows the running task, the queue, and what needs Enrique. Health collapses to a strip. System lane hidden by default.

**Test** With a heavy task running, the first screenful on a phone is that task. With nothing running, Home reads calm rather than broken.

**Debug** If Home still feels like a status page, count what is above the fold on a 375px viewport. The running task and the queue must be there before anything about disk or memory. When there is no running task, check the empty state on a real device — a calm empty state and a broken one look identical in a desktop browser.

**Done when:** disk percentage is no longer the first thing on the page.

## S13b — The build progress bar
*Size: 1 day. Lives on Home until the build is finished, then retires.*

While Jarvis is being built, the most useful thing on the home page is **how far
along the build is**. Enrique asked for it directly: the length of the plan, and
how much of it the agent has done.

### The data

`PROGRESS.json` at the repo root — root rather than `docs/` (owned by the plan)
or `src/` (it is data, not code). The building agent writes it; the console reads
it directly. No endpoint, no table: the file is versioned in git, so the bar's
whole history is auditable and a state change is a diff with a timestamp.

```json
{
  "plan_file": "docs/JARVIS_MASTER_PLAN_V2.md",
  "plan_sha": "<sha of the plan when last read>",
  "total_steps": 37,
  "updated_at": "<iso8601>",
  "current_step": "S5",
  "steps": [
    {"id": "S1", "stage": 1, "state": "done", "pr": 7,
     "evidence": "all five harness variants observed"},
    {"id": "S5", "stage": 1, "state": "in_progress"},
    {"id": "S6", "stage": 1, "state": "blocked", "blocker": "BLOCKED.md#netcup-ssh"}
  ],
  "gates": {"1": "green", "2": "pending"}
}
```

States: `not_started` · `in_progress` · `partial` · `blocked` · `done`.

### The integrity rules — the entire point

A progress bar is the most temptingly roundable artifact in any project, and this
one is **self-reported by the party being measured.** So:

- `done` requires **both** that the step's "Done when" line was observed **and** that its PR is merged to main. Either alone is `partial`.
- A step waiting on Enrique is `blocked`. Never `done`, never quietly skipped.
- A step whose real half is covered only by the fake harness is `partial`, and it says which half is real.
- A gate is `green` only when every test under it has passed **with evidence attached**. Not "should pass".
- **`total_steps` is counted from the plan on every update, never hardcoded.** The plan has grown from 30 steps to 37 during the build, and a stale denominator turns the bar into a flattering lie.
- Where two states are arguable, **pick the lower one.**

Updated in the same commit as the change it describes — starting a step,
finishing one, hitting or clearing a blocker, closing a gate. Never batched at
the end of a session, because a bar updated in batches is a bar that was
reconstructed from memory.

### The UI

One horizontal bar on Home, above the fold, segmented by the seven stages and
each segment sized by its step count. Done solid; in-progress hatched; blocked in
the alert colour; not-started empty. Beside it: `S5 of 37 · Stage 1 · 4 done,
1 blocked`. Tapping a segment lists that stage's steps and states. The blocked
count links to `BLOCKED.md`.

If `PROGRESS.json` is older than 24 hours, the bar **says so** rather than
presenting stale numbers as live.

### Test

- Every state renders distinguishably, including on a phone and in the colour-blind-safe palette. Blocked must not read as done.
- Add a step to the plan → the denominator grows on the next update and the percentage **goes down**. That is correct behaviour and the bar must not hide it.
- Stale file → the staleness notice appears; back-date `updated_at` to force it.
- A step marked `done` whose PR is not merged → the console flags the inconsistency rather than trusting the file. **The bar is a claim, and the console is allowed to check it.**
- Malformed or missing `PROGRESS.json` → the bar is absent with a plain explanation, never a half-drawn bar or a crash.

### Debug

If the bar and reality disagree, believe git. Cross-check `state: done` against
merged PR numbers before believing the file, and say so on screen when they
differ — a progress bar nobody trusts is worse than no progress bar, because it
still gets looked at.

If percentages jump around, the denominator is being hardcoded somewhere despite
the rule. Grep for the literal number.

**Done when:** Enrique can open Home on his phone and see, in one glance and
without asking, how much of the plan is built, what is being worked on now, and
what is waiting on him.

## S14 — Live work detail
*Size: 2–3 days.*

**Build** Phases, live tool events over SSE, tests, review findings, artifacts, timers, checkpoints, PR links, originating inbox events. "Live updates paused" after 5s of SSE silence.

**Test** Watch a complete S6 run from the console with no terminal access. Kill SSE mid-run → banner appears, then reconnects and catches up without losing events. Unknown renders `unknown`, never `0`.

**Debug** Events arriving but not rendering is usually the throttle, not the transport. Inspect the raw event stream in the browser.

**Done when:** an entire engineering run is legible from a phone.

## S15 — Repair the degraded console
*Size: 3–4 days.*

**Build** Audit every page against real API fields. Mobile first.

### The thirteen states

Every important screen defines all of these, explicitly, rather than falling
through to a blank panel:

`loading` · `empty` · `healthy` · `degraded` · `offline` · `stale` ·
`permission denied` · `waiting for user` · `waiting for provider` ·
`recovering` · `failed` · `partially available`

An empty queue says **"No work is currently queued. Jarvis is available."** — not
an ambiguous blank. A blank panel is indistinguishable from a broken one, and
after the second time it is broken, Enrique will assume every blank panel is a
bug and stop trusting the page.

`stale` and `partially available` are the two that get skipped and the two that
matter most: a screen showing real numbers from twenty minutes ago, with no
indication of that, is worse than a screen showing nothing.

### Accessibility and mobile quality

Not decoration — this console is used one-handed, on a phone, often outdoors,
sometimes while doing something else:

- Accessible contrast throughout.
- Full keyboard navigation with a **visible** focus state.
- Semantic labels, and screen-reader announcement of status changes — a task moving to `failed` must be announced, not only recoloured.
- **No information conveyed by colour alone.** Every state carries a shape, an icon, or a word as well. This applies directly to the S13b progress bar, where `blocked` and `done` must be distinguishable without colour.
- Touch targets large enough to hit while walking.
- Responsive tables that become expandable cards on mobile rather than scrolling sideways.
- No horizontal page overflow, anywhere.
- Respect `prefers-reduced-motion` — the hatched in-progress states and any pulsing must stop.
- **Installable as a PWA** so it lives on the phone home screen. Web push is explicitly **not** V1: WhatsApp is the pager, and a second notification channel is a science project that would compete with the one that works.

**Test**
- L17's six journeys on a real phone: check health, add context to a running task, resolve an API-key issue, approve something, reprioritise the queue, open an artifact.
- Every page against a project with **zero** data and one with a great deal. Empty states and overflow are where consoles actually break.
- **Every one of the thirteen states, on at least one screen each.** Force them: kill the API for `offline`, revoke a session for `permission denied`, freeze the clock for `stale`. A state you cannot force is a state you have not implemented.
- Navigate the entire console with the keyboard alone, and confirm focus is visible at every stop.
- Run it in greyscale. Every status must still be readable — this is the fastest possible test for colour-alone information and it takes one minute.
- Turn on reduced-motion and confirm nothing pulses, hatches or animates.
- Install it as a PWA on the phone and complete one full journey from the home-screen icon.

**Debug** A page that renders in dev and breaks in production is almost always a field the API stopped returning; compare the live JSON against what the component destructures. If a number looks wrong rather than missing, find its source query before touching the component — v1's console under-reported for days because the count was capped upstream.

**Debug** If a page looks fine but reads badly in greyscale, the state is
encoded in a colour token rather than in content — fix the component, not the
palette. If focus disappears mid-navigation, something is rendering a custom
control without a real focusable element underneath it.

**Done when:** all six journeys work on a phone, the console is fully navigable
by keyboard, every status survives greyscale, and no page shows an invented
number or an unexplained blank.

## S16 — The credential loop
*Size: 2 days.*

**Build** Jarvis needs a key → ticket + one link → action page with a masked field and a plain statement of purpose and cost → submitted to the broker → connection tested → ticket closed → parked task resumes.

**Test** N4 end to end with no terminal. Expired link → refused. Replayed link → 409. Wrong key → connection test fails, ticket stays open with a useful message rather than a stack trace.

**Debug** If the parked task does not resume, the ticket closed but nothing requeued it — check the transition, not the form. A key that submits and then fails its connection test is usually being written to the wrong auth profile; confirm which profile id the broker actually stored.

**Done when:** a dead credential is repaired from a phone and the parked task resumes by itself.

## S17 — Artifacts and output control
*Size: 3 days.*

**Jarvis's outputs are first-class objects, not files attached to a log.** This
is the mechanism by which Enrique controls the *quality* of what Jarvis produces,
rather than only whether it ran — and the plan has so far treated an artifact as
a byte blob with a path.

### Types

Pull request, commit, patch, report, document, spreadsheet, screenshot, dataset,
downloaded file, test report, browser recording, deployment URL.

### States

```
draft → generated → under_review → ready → approved → delivered
                          ↓                    ↓
                       rejected            superseded
```

`superseded` matters as much as `rejected`: a second attempt at the same output
must not silently orphan the first, or the version history that makes review
possible disappears.

### Build

- Extend the `artifacts` table with type, state, version, `supersedes_id`, review state and reviewer notes. Migration in the agent's next free number.
- An artifact page showing: preview or link, its project/task/conversation, the creating agent + model + harness + auth profile **by id**, timestamp, review state, version history, Enrique's feedback, and delivery state.
- Actions on it: approve, reject, request revision, add context, open/download, compare versions.
- **Request revision creates a task.** Rejecting an output with a note is a work instruction, not a status change — it goes back to the queue against the same project with the note attached, so the loop closes without Enrique restating anything.
- Delivery state is separate from approval. Something can be approved and not yet delivered, and the console must not imply otherwise.

### Test

- Produce each artifact type at least once and confirm the page renders it — a dataset, a screenshot and a PR are three very different previews and only one of them is a link.
- Walk the full state path, then the two exits. Reject with a note → a task appears with that note. Approve → it can be delivered.
- Generate v2 of an artifact → v1 becomes `superseded`, both remain, and compare-versions shows the difference.
- Download an artifact through the API gate; confirm a quarantined one cannot be downloaded at all.
- A task that produces **no** artifact says so plainly rather than showing an empty panel that reads like a loading state.
- Fifty artifacts on one project → the page paginates rather than dying.

### Debug

If an artifact shows no creator, the run recorded the file but not the
provenance — check the registration call, not the page. Provenance written later
is provenance that will sometimes be missing.

If version history is wrong, look at `supersedes_id` before the UI; an artifact
overwritten in place rather than superseded has already destroyed the evidence
and no amount of UI work will bring it back.

If the preview is blank for one type only, that type has no renderer and is
falling through to the default. Say "no preview available" rather than rendering
nothing — a blank panel is indistinguishable from a broken one.

**Done when:** an output can be reviewed, rejected with a note that becomes a
task, revised, and the two versions compared — without leaving the console.

## S18 — Global search, the command palette, and the activity feed
*Size: 3 days.*

By this point Jarvis holds months of conversations, tasks, issues, artifacts and
memories, and the only way to reach any of it is to know which page it lives on.
That is the point at which a console stops being usable — and it is the point
Enrique will actually be at.

### Build

**Global search**, across everything, from one box: projects, conversations,
tasks, issues, files, artifacts, memories, connections, pull requests, schedules.
Results grouped by kind, each one a link to the thing itself. It shares the
retrieval path built in S28, so a search for a phrase finds it in a dumped
document as readily as in a task title.

**A command palette** on `Ctrl/Cmd+K`, because the fastest interface for someone
who already knows what he wants is typing it:

```
Create project          Open queue              Pause task
Start conversation      Open unresolved issues  Add connection
Show current task       Create schedule         Search <project> conversations
```

Palette actions are the same API calls the pages use. A command that exists only
in the palette is a second implementation waiting to drift.

**Two data objects the schema is missing**, both needed for things the plan
already promises:

- `resource_metrics` — CPU, RAM, disk, I/O sampled over time. Today host metrics are computed live and thrown away, so the console can say "disk is at 84%" but never "disk has climbed 9 points this week", and Maintenance cannot act before a threshold rather than after it.
- `activity_events` — one ordered feed per project and globally. `audit_events` answers "who did what to the system"; this answers "what has been happening on Alpha", which is a different question and the one Enrique asks.

### Test

- Search a phrase that exists **only** inside a dumped PDF and find it. Search one that exists in a task title, an artifact name, and a memory → all three appear, grouped.
- Search with zero results → says so, rather than rendering an empty list that looks like a loading state.
- Every palette command executes, and each one lands on the same endpoint as the equivalent page action. Diff the two call sites if unsure.
- Palette on mobile — where there is no keyboard shortcut, it needs a reachable control or it does not exist.
- Resource metrics: let it run 24h, then confirm the console can draw a trend and Maintenance can see a slope rather than a snapshot.
- Activity feed on a project with no activity, and on the busiest one — empty state and pagination are where feeds break.
- Search scoped to project A never returns project B's content. **This is an isolation test, not a UX test**, and it stops other work if it fails.

### Debug

If search is slow, look at whether it is scanning artifact *bytes* rather than
extracted text; the index should hold text, and blobs should never be in the
query path.

If results are dominated by one kind, ranking is comparing incomparable scores
across sources — normalise per kind before merging, or group and rank within
groups rather than pretending one global ordering is meaningful.

If a palette command works from the page but not the palette, the palette built
its own request. That is the drift this step exists to prevent; delete the second
implementation rather than fixing it.

**Done when:** a phrase inside a document dumped three months ago is findable in
one search, every palette command works on desktop and mobile, and search cannot
cross a project boundary.

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
comments in `callcontrol.ts` today and regression tests after S19:

- **Self-transcription.** Recording started with the greeting, so Whisper transcribed Jarvis's own voice back as if the caller had said it.
- **The runaway loop.** Every reply's own `playback.ended` armed another recording, so one utterance produced several transcriptions, each producing a reply, each arming more sessions.

## S19 — Call reliability hardening
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

## S20 — Turn-taking and barge-in
*Size: 2 days.*

**Build**
- Roughly five seconds of silence hands the turn to Jarvis (transcript msg 15).
- **Barge-in**: Enrique speaking over Jarvis stops playback immediately and starts listening. Being talked over by your own assistant is the single most irritating failure in voice UX.
- Tune the endpointing so a natural pause mid-thought is not treated as the end of a turn.

**Test** Interrupt at the start, middle, and end of a long reply — playback stops within a beat each time. Pause three seconds mid-sentence and continue: Jarvis waits. Pause six: Jarvis takes the turn. Background noise and a TV playing do not trigger a turn.

**Debug** If barge-in is laggy the audio stream is being buffered before detection. Measure from the caller's first syllable to playback stop; anything over ~300 ms feels rude.

**Done when:** a two-minute natural conversation runs with no talking over each other in either direction.

## S21 — The conversational orchestration runtime
*Size: 4–5 days. The step that makes the phone feel like Jarvis rather than like an IVR.*

Turn-taking (S20) gets the mechanics right: who speaks when. This step is about
what happens **during** a turn, and it is the difference between a voice
interface and an assistant.

The behaviour Enrique described: it acknowledges — but not the same way every
time — says it is going to check something, goes and actually checks it, comes
back and answers. Then possibly thinks again. A real conversation with someone
who is doing something while talking to you.

### The governing trade-off

**On the phone, fast and shallow beats slow and deep. Every time.**

The phone is a conversation and a capture surface, not where deep work happens.
Anything that needs real thinking is recorded, queued, and picked up by the main
Jarvis system afterwards — the call does not wait for it, and Enrique is told
plainly that it has been handed over. A twenty-second silence while a model
reasons is a worse experience than an immediate "I don't know off-hand, I've put
it in the queue."

### Three concurrent tracks

The runtime runs three things at once, which is why it is a runtime and not a
request handler:

1. **The voice loop** — listening, endpointing, speaking. Never blocked by anything else. Sub-second, always.
2. **The tool track** — lookups, memory search, task creation, running asynchronously. It reports progress; it never holds the line.
3. **The speech scheduler** — decides *what to say and when*, given what the tool track is doing and whether Enrique is talking.

### The turn shape

```
Enrique stops speaking
   └─ ≤700ms  acknowledgement (varied, contextual)
   └─ tool track starts
        ├─ resolves <2.5s  → answer directly, no filler
        ├─ still going at 2.5s → "let me check that" (varied)
        ├─ still going at ~10s → a real progress line, not a repeat
        └─ still going at 25s → "I'll have the desk finish this and come
                                 back to you" → task queued, turn released
   └─ answer, then hand the turn back
```

### Acknowledgement must not be stagnant

The single thing that makes a voice agent feel dead is the same phrase every
time. Requirements:

- A pool of acknowledgements per situation — thinking, checking, found it, not found, handing over — and **never the same one twice in a row**, tracked per call.
- Phrasing follows the content. "Let me pull up Alpha" is not "let me check that": naming the thing proves it was heard, and that is what makes an acknowledgement reassuring rather than a stall.
- Progress lines say something new each time. A second "still working on it" is worse than silence, because it proves nothing is happening.
- Everything is **interruptible**. If Enrique speaks over an acknowledgement, it stops instantly and listens — the acknowledgement was never the point.

### Proactive speech

The runtime may speak without being asked, in three cases only: a progress
update on the schedule above; a result arriving from the tool track after the
conversation moved on ("that Alpha question — it was the migration"); and a
closing line when he has been silent long enough that the call is over.

It may **never** fill silence for the sake of it. A pause where Enrique is
thinking is his, and talking into it is the most irritating thing a voice agent
can do.

### Everything is captured regardless

Every utterance is persisted before any of the above happens (persist-first, as
everywhere else). Whether the runtime answers well, answers badly, or hands over,
**what he said is recorded and routed by S3 exactly as a WhatsApp message would
be.** The conversation quality and the work are independent: a call where Jarvis
sounds vague can still produce three correctly-scoped tasks.

This is the safety net that lets the phone be fast. It is allowed to be shallow
because nothing is lost by being shallow.

### Build

- A per-call runtime with the three tracks above, on the persisted call state machine from S19.
- An acknowledgement bank with per-call no-repeat tracking and content-aware selection.
- Async tool invocation with progress events, a hard phone-side budget (~25s), and clean handover to the queue when it expires.
- Barge-in that cancels playback, in-flight TTS render, and any speech queued behind it.
- Latency instrumentation on every leg, stored per turn, so "it felt slow" becomes a number.

### Test

- **The variety test**: a five-minute call with many lookups. No acknowledgement repeats consecutively, and progress lines never repeat verbatim. Grep the transcript for consecutive duplicates — this is mechanically checkable, so check it mechanically.
- **The budget test**: force a tool to take 60s. At 2.5s a holding line, at ~10s a real update, at 25s a clean handover with a task created. The call never goes silent for more than ~10s.
- **The interruption test**: speak over the acknowledgement, over a progress line, and over the final answer. Each stops within a beat and listens.
- **The silence test**: pause 4s mid-thought → it waits. It does not fill.
- **The capture test**: make a call where every tool fails. Confirm the utterances are still persisted and routed, and tasks still created. **Conversation quality and capture must be independent.**
- **The shallow-is-fine test**: ask something needing real work. Confirm it hands over quickly rather than grinding — and that the queued task carries the full request, not a summary of it.
- Ten calls: p50 and p95 acknowledgement latency, reported as numbers, both under target.

### Debug

If it feels sluggish, read the per-leg timings before touching prompts — it is
almost always TTS render on an uncached phrase, not the model. Pre-render the
acknowledgement bank; a fixed phrase should never pay for synthesis twice.

If acknowledgements repeat, the no-repeat state is being lost between turns —
check it lives on the call, not in a request-scoped variable.

If barge-in leaves it talking, something downstream of the cancel is still
holding audio: cancel the render *and* flush the queued playback, not just the
current one.

If it narrates progress it isn't making, the tool track is reporting scheduled
rather than started. Progress lines must be driven by real events; inventing
progress is worse than silence because it is a lie told confidently.

**Done when:** a five-minute call feels like talking to someone who is doing
things while you talk — varied, interruptible, never silent for long, honest when
it has to hand over — and every word of it is captured and routed regardless of
how well the conversation went.

## S22 — The desk actually does the work
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

## S23 — Jarvis calls Enrique
*Size: 2–3 days. Does not exist at all today — only the quiet-hours check does.*

**Build**
- Outbound dial through Telnyx, reusing the same call state machine and voice as inbound.
- **The reasons it may call, and no others:**
  1. A task blocked over an hour on something only Enrique can unblock.
  2. A production incident on a professional project.
  3. A destructive action awaiting approval past its window.
  4. A security or isolation event.
  5. **A call he scheduled.** "Call me tomorrow at 9 to go over the Alpha migration" is a first-class request — it creates a schedule whose action is a call, with its subject prepared in advance.
  6. **A monitoring rule he explicitly authorised to call.** Per rule, opt-in, never a default.
- **Quiet hours 19:30–08:00 America/New_York, enforced at the dial site**, not in the UI. Weekends are fine. A blocked call becomes a WhatsApp plus an Issue and retries at 08:00.
- **The one override, and it is narrow.** A confirmed security incident or active data loss may ring inside quiet hours. Nothing else may — not a production outage, not a blocked task, not an approval. The override list lives in config, is auditable, and is short enough to read aloud.

  *Flagged for Enrique:* the planning conversation recommended this override and you confirmed the rule set while changing the hours to 19:30. It was never restated explicitly, so it is written narrowly here. Say the word if you want quiet hours to be absolute instead — a 3am data-loss call is precisely the case where the stricter reading costs the most.
- It opens by saying who it is and why it is calling, in one sentence, before anything else.
- No answer → voicemail-safe behaviour, then fall back to WhatsApp. Never redial in a loop.

**Test**
- Trigger each of the six reasons and confirm a call for those and **only** those. A routine completion must never ring the phone.
- Set the clock to 20:00 → refused, WhatsApp + Issue instead, retried at 08:00 (L13).
- A **security incident** at 02:00 → rings. A production outage at 02:00 → does **not**. That pair is the whole override, and testing only the first half proves nothing.
- Saturday 10:00 → allowed.
- Schedule a call for a specific time → it rings then, with its subject ready, and does not ring twice after a restart.
- Decline the call → one WhatsApp, no redial loop.
- Answer it → the reason is stated in the first sentence.

**Debug** The commonest failure will be calling too often. Instrument the decision and review a week of it before trusting it; a Jarvis that cries wolf gets silenced permanently.

**Done when:** a genuinely blocked task rings the phone during the day and stays silent at 21:00.

## S24 — Voice memory and review
*Size: 1–2 days.*

**Build** Every call: recording (retention-classed like WhatsApp audio — 7 days, never past 10 unless marked permanent), transcript, summary, and any tasks it produced, all attached to a conversation and visible in the console.

**Test** Make a call, then find it in the console and read what was said and what it caused. Ask in a later call "what did I ask you about Alpha yesterday?" and get it right. Confirm the raw audio is gone at day 7 and the transcript remains (L12).

**Debug** If a call has no transcript afterwards, the artifact was written but never registered, or registered against the wrong project. Check `artifacts` by path. If retention deletes too early, the `retain_until` was computed at ingest from the wrong clock — verify against a call made just before a day boundary.

**Done when:** a call is as reviewable as a chat thread, and audio retention holds.

---

# STAGE 5 — MAKE IT REACH

## S25 — Shrink the model routing
*Size: 1 day. Do it early — it removes code every later step would otherwise inherit.*

**Build** Cut to what is real: Fireworks open-weights primary plus one fallback for the Supervisor; Claude Code on subscription for the engineer; Groq Whisper for STT; ElevenLabs for TTS. Delete the dead free-tier chain. Authentication stays per **provider**, never per model.

**Test** `/api/models` shows two healthy supervisor routes and no `discovered` row pretending to be routable. Kill the primary → failover, same conversation id, no metered enablement (L4). Add a second model on an existing provider → **no** new key requested. Mark a coding subscription exhausted → the next task lands on the next engine silently; mark all of them exhausted → *then* it parks, naming which and when each resets.

**Debug** A route that looks healthy but never serves is usually failing its probe silently and being left `degraded` rather than dropped. Read `model_registry.last_error`. If a supposedly deleted provider still appears, something is re-seeding it on boot — grep the migrations and the catalog seeder before editing rows by hand.

### Quota is a routable resource, not just a failure

The plan has been treating a subscription limit as an error — park the task and
notify. That is wrong, and it wastes the main advantage of running on flat-rate
subscriptions. **Remaining quota is an input to routing.**

Jarvis should know, per profile:

```
claude_personal      quota_status = healthy
openai_codex         quota_remaining = 62%
cursor_personal      monthly_usage = 41%
fireworks            metered, ceiling $20, spent $6.40
groq                 requests_remaining_today = 763
```

and route on: task complexity, project confidentiality, model capability,
**remaining quota**, provider availability, latency, and cost. So:

- "Rename this variable" → the cheap utility route, never a coding subscription.
- "Investigate why checkout occasionally creates duplicate orders" → Codex. At quota? → Claude Code. Exhausted? → Cursor. All three spent? → **the paid hosted route, within the ceiling.** Only when that is also exhausted does the task park, and it says which engines were spent and when each resets.

Parking is the last resort, not the first response. A task that stops because
one of three available engines was busy is a task that did not need to stop.

Track quota from what the provider actually reports plus what Jarvis has spent.
**Where a subscription exposes no usage API, infer conservatively from observed
rate-limit responses and say the number is an estimate** — a confident wrong
quota figure is worse than an honest unknown, because it will route around an
engine that was actually available.

**Done when:** every registered route has passed a real tool-enabled call, and a
coding task whose primary subscription is exhausted completes on the next engine
without Enrique being told anything.

## S26 — Project onboarding and `AGENTS.md`
*Size: 2–3 days. S6 reads this file; nothing currently writes it.*

**Build** Creating a project is a conversation. Jarvis asks and does not guess: personal or professional; production and customer-facing status; confidentiality; exact GitHub owner/repo or permission to create a private one; which auth profiles may see this data; metered paid APIs and the ceiling; deploy environments and approval rules; required tests, review, backups, monitoring.

On finalize it **writes `AGENTS.md` into the repository** from `docs/TEMPLATES.md` and versions it in `project_instructions_versions`.

**Test** Create a project by voice; the committed `AGENTS.md` matches the answers. Skip a required answer → it asks again rather than defaulting. Create a professional project → paid/subscription profiles only, and a free consumer endpoint is refused for its source code.

**Debug** If `AGENTS.md` lands with template placeholders still in it, finalize ran before every answer was collected — the onboarding session must refuse to finalize on a missing required field rather than substituting a default. If the committed file and the database disagree, decide which is canonical now and enforce it; two sources of project policy is a bug that gets worse with time.

**Done when:** a project created by voice ends with a correct committed `AGENTS.md`.

## S27 — Configuration by conversation
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

## S28 — The runtime interface and a second harness
*Size: 3 days. Must land before S29 — the evaluation suite has nothing to compare until two harnesses exist.*

The planning conversation calls this "probably the single most important
architectural decision we make", and it is the one that makes the rest of Jarvis
outlive its parts.

### The principle

Jarvis must never *be* its harness. It talks to an abstract runtime:

```
Jarvis
  └── AgentRuntime
        ├── ClaudeCodeRuntime      (today)
        ├── CodexRuntime
        ├── CursorRuntime
        └── FutureRuntime          (a self-hosted model, five years from now)
```

and asks for work in terms that name no vendor:

```
run_task(
  project      = "ticketflipping",
  objective    = "Fix the checkout bug and open a PR",
  permissions  = ["repo:write", "github:pr"],
  model_profile= "coding-large"
)
```

It should not care which engine underneath serves that. When Enrique eventually
buys a machine and runs the weights himself, the swap is a new runtime
implementation and a registry row — **Jarvis does not change.** That is the whole
payoff, and it is only available if the seam is built before there is a second
implementation to force it.

### Build

- Extract the harness call in `runner.ts` behind an `AgentRuntime` interface: start a run, stream events, checkpoint, cancel, report a terminal outcome. Nothing vendor-specific crosses that line.
- Normalise events. Each runtime emits its own format; the interface exposes one — phase, tool call, output, error, result. `task_events` stores the normalised shape, so the console and the evaluation suite work identically whichever engine ran.
- Implement **CodexRuntime** as the second one. The fake harness from S1 is already a third implementation, which is how you know the interface is honest rather than shaped around a single vendor.
- The runtime used is recorded on the task, and selectable per project and per task.

### Test

- The same task runs to a passing PR on Claude Code and on Codex, changing one field and nothing else.
- The console renders both runs identically — if one shows phases and the other does not, the normalisation is incomplete.
- The fake harness still satisfies the interface. **An interface that only two real vendors fit is a coincidence, not an abstraction.**
- Point a task at a runtime that is not installed → a clean `provider.cred_expired`-class park with a useful message, not a crash.
- Kill a run on each runtime and confirm recovery is identical from the outside.

### Debug

If adding the second runtime requires changing anything outside its own file, the
interface leaked and the leak is where the vendor assumption lives — usually
event parsing or exit-code interpretation. Fix the seam rather than special-casing
the caller.

If the same objective behaves very differently on the two runtimes, check the
prompt and permissions being passed before blaming the model; the two CLIs take
different flags for the same intent, and that translation belongs inside the
runtime.

**Done when:** one task runs on either harness by changing one field, both look
the same in the console, and the fake harness still fits the interface.

## S29 — The engineering evaluation suite
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

The suite also sets each role's **quality floor** (VI.2) — the score below which
a model may not serve that role unattended. A floor is only meaningful once the
suite has enough cases to separate a good model from a fluent one, so set it from
observed scores rather than picking a round number first.

**Test**
- Run two harnesses through it and confirm the winner is what routing actually uses afterwards.
- Feed it a deliberately bad model and confirm it scores badly rather than passing on fluency — a suite that everything passes measures nothing.
- Re-run the same pair twice: scores should be close. Wild variance means the suite is measuring noise and needs more cases before anyone trusts it.

**Debug** If every candidate scores the same, the cases are too easy. Add cases from bugs that actually took real time to solve.

**Done when:** the `senior_engineer` route was chosen by measurement, and rerunning the suite reproduces the ranking.

## S30 — Memory and knowledge
*Size: 4–5 days. Write ADR 017 first — but the recommendation below is the starting position, not an open question.*

Transcript msg 01: "somewhere where I can just dump stuff, and it will organize
it. I will be able to ask questions about anything at any time."

### Four tiers, deliberately separate

The transcript is explicit that dumped material must be **separated from
conversational memory**, and it names a fourth tier the plan had collapsed:

```
Jarvis memory
├── Global memory      durable notes not scoped to any project
├── Project memory     notes scoped to one project
├── Knowledge          what he dumped: documents, PDFs, spreadsheets,
│                      webpages, source code, audio transcripts, images,
│                      raw notes
└── Activity history   what happened: tasks, decisions, executions, approvals
```

Separate because the questions are different, and mixing them makes both worse:

- *"What did the client say about the refund window?"* → **knowledge**. Answer from the document, cite it.
- *"Why did we set Alpha's deploy policy to manual?"* → **activity history**. The answer is a decision and its reasoning, and it lives in `activity_events` and `config_versions`, not in a chunk.
- *"What do you know about how I like PRs written?"* → **global memory**.

A retrieval that returns a chunk of a PDF when the honest answer is "you decided
that on the 14th, here is the task" is a wrong answer that looks right — the
worst kind. Search ranks **within** tiers and says which tier each result came
from; it never merges them into one undifferentiated list.

**Activity history is queryable memory, not just a feed.** S18 builds
`activity_events` for the console; this step makes it answerable in language.

### The architecture, decided

**Postgres full-text search first. Embeddings only when it proves insufficient.**

The instinct is to reach for a vector store. Resist it here, for three reasons
specific to this machine:

- Postgres is already running, already backed up, already restored by the drill, and already inside the isolation model. A separate vector store is a second thing to back up, secure, scope per project, and restore — and `docs/GAP_ANALYSIS.md` exists because v1 built infrastructure ahead of need.
- ADR 007 gives embeddings 1024 MB **and forbids them while heavy work is active**. An embedding tier that can only run when the box is idle is a poor foundation for "ask me anything at any time".
- The corpus is one person's documents and chat history, and most real queries are lexical — a name, a client, a project, an error string. `tsvector` with good chunking answers those well.

So: `knowledge_chunks` with a `tsvector` column, GIN index, chunked with overlap,
ranked with `ts_rank_cd`, scoped by `project_id` with a global tier for
Supervisor memory. Every answer cites the chunk and the artifact it came from.

**Add embeddings when, and only when, a measured recall failure demands it.**
Keep a file of queries that returned the wrong thing; when lexical search is
demonstrably the cause of several, that is the evidence for ADR 017b and a local
embedding model on the system lane. Not before.

### Build

- Ingest anything: documents, pasted logs, transcripts, forwarded threads, call transcripts, PDFs. Chunk with overlap; keep the source artifact.
- Scope every chunk to a project, or to the global Supervisor tier. **The project filter is applied in the query, not in post-processing** — a cross-project chunk must never be retrievable in the first place.
- Answers cite: which artifact, which chunk, when it arrived.
- A `memory_search` path the Supervisor and the harness both use, so a coding task can consult what Enrique said about the project three weeks ago.

### Test

- **N2 end to end**: dump a long thread and three PDFs, then ask a specific question with the clock shifted three weeks forward. The answer is correct and cited.
- Survive a reboot — then survive a **restore from backup**, which is the test that actually matters and the one v1's backups would have failed.
- Ask about project A; assert project B's chunks are not in the retrieved set. Not absent from the answer — absent from the **retrieval**.
- **One question per tier**, and check each answer comes from the right one. "Why did we decide X" must answer from activity history, not from a document that happens to mention X.
- A question answerable from two tiers → both offered, each labelled, rather than one silently winning.
- Ask something genuinely not in the corpus → it says it does not know. **A confident answer from nothing is the worst possible failure here**, and it is the one this design is most exposed to.
- Ingest the same document twice → no duplicate chunks, no doubled ranking.
- A 200-page PDF and a 3-word note both ingest without special-casing.

### Debug

Wrong or missing answers are nearly always retrieval, not the model: **log the
retrieved chunks before blaming the reply.** If chunks from another project
appear, that is an isolation bug and it stops other work until closed.

Poor recall after a restart means the index did not survive — an index that
silently rebuilds empty will answer confidently and wrongly, which is worse than
erroring. Assert on chunk count after boot.

If ranking looks random, check the chunking before the ranking. Chunks split
mid-sentence, or a whole 40-page document as one chunk, will defeat any ranker.

**Done when:** N2 passes across a restore from backup, with correct citations, no
cross-project leakage, and an honest "I don't know" when the answer is not there.

## S31 — Composio and MCP
*Size: 4–5 days. After S6, so there is something to use them.*

**Build** The Composio adapter, so any Composio-supported service is reachable under project scope through the broker. Then a generic MCP client: attach any MCP server, scoped to a project, tools surfaced to the harness. Untrusted servers run in Docker, never on the host.

**Test** A project-scoped Composio connection used by a heavy task; the same connection denied to a second project. An MCP server attached to one project and invisible to another. A deliberately hostile MCP server cannot escape its container or read another project.

**Debug** A Composio call that works for one project and fails for another is the broker doing its job — confirm the denial is deliberate before treating it as a bug. An MCP server that hangs takes the heavy lane with it: every MCP invocation needs a timeout, and a server that times out twice gets disabled with an Issue rather than retried forever.

**Done when:** a heavy task completes real work through a Composio connection, and cross-project access is denied and audited.

## S32 — Browser and scraping
*Size: 5–6 days. Named in the very first planning message and still at zero. Write ADR 016 before any code — this has never been designed.*

Enrique's first message asked for an agent that is "extremely good with scraping,
in any sense of scraping", and named a package that dictation rendered as "Paw
HTTPS" — almost certainly a TLS-fingerprinting HTTP client (`pyhttpx`,
`curl_cffi` or similar). **Confirm which one he meant before choosing**; the
choice determines whether the fetch tier can pass fingerprint checks at all.

### Two modes, and they are not the same thing

The transcript draws a distinction the plan had blurred, and it is the one that
decides whether this is affordable:

**Mode 1 — Browser agent.** The model drives a real browser, step by step.
For *"log into this dashboard and change that setting"*: one-off, interactive,
needs judgement at every click. Expensive per action, and that is fine, because
there are ten actions.

**Mode 2 — Scraping engine.** For *"collect every listing across 14,000 pages"*.
Here the model does **not** drive the browser.

> **The agent determines *how* to scrape. Normal software performs the actual
> scraping.**

The model inspects a few pages, works out the shape — URL pattern, selectors,
pagination, rate limit — and emits a **deterministic scraper**. Then ordinary
code runs it 14,000 times with no model in the loop at all.

Making an LLM click through Chrome 14,000 times is the single most expensive
mistake available in this system: orders of magnitude slower, costs per page, and
fails in a new way each time. Mode 2 exists to make that impossible rather than
merely discouraged.

### Mode 2's strategy ladder

Within the generated scraper, pick the cheapest fetch that works and escalate
only on failure:

1. **Plain HTTP** — sane headers. Most APIs and static pages. Milliseconds, no RAM.
2. **Fingerprinted HTTP** — a TLS-fingerprinting client for sites that reject stock clients on JA3/JA4 before serving any content. Still cheap; handles most "works in my browser, not in code" cases.
3. **Headless browser** — only for pages that genuinely need JavaScript execution or an authenticated session. **Occupies the single heavy slot** (ADR 007): while a browser is scraping, no coding task runs.

Tooling to draw on: an HTTP client, an HTML parser, Playwright/Patchright,
Crawlee, curl, and hand-written scrapers. The mode and tier used are recorded on
the task, so a slow or costly scrape can be explained afterwards rather than
guessed at.

### Build

- **Project-scoped browser profiles** at `/var/lib/jarvis/browsers/<project_id>`, never shared. Cookies, local storage, and saved logins belong to one project and are invisible to every other. A browser worker gets **no** harness-auth mount (ADR 006).
- **Containerised.** Unlike the coding harness, the browser runs in Docker — it executes untrusted remote code by definition. This is not the ADR 015 exception.
- **A fetch/extract toolkit**: retries with backoff, per-domain rate limiting, structured extraction (CSS/XPath/JSON-path), pagination, and a saved snapshot of every page it parsed.
- **Politeness by default**: honest user agent unless the project's `AGENTS.md` says otherwise, `robots.txt` respected unless explicitly overridden per project, and a per-domain request ceiling. Overriding either is a project-level decision recorded in the repo, not a per-task whim.
- **Output is an artifact**, not a log line: structured data plus the raw pages it came from, so a wrong result can be diagnosed without re-scraping.
- **A login flow that asks.** When a site needs credentials Jarvis does not have, it raises a `UserActionRequest` with a link — the same credential loop as S16. It never guesses at, stores, or reuses a login across projects.

### Test

- **The 14,000-page test, at small scale**: point Mode 2 at a paginated site and confirm the model is invoked to *design* the scraper and then **not once per page**. Count model calls. If they scale with pages rather than with page *shapes*, Mode 2 is not implemented — it is Mode 1 wearing a costume, and it will be discovered by the bill.
- A Mode 1 task — log into something and change a setting — completes with the model driving, and does not silently fall into Mode 2.
- Each tier individually against a site that requires exactly that tier. Assert the escalation actually happens and is recorded.
- Project A's cookies and profile unreachable from project B. Assert it; a success here is an isolation bug that stops other work.
- Kill the browser mid-scrape → recovers or fails cleanly. **Never hangs the heavy lane** — this is the most likely way scraping takes the whole system down.
- Run under memory pressure with the browser holding the heavy slot; confirm no coding task starts concurrently and `MemAvailable` stays above the floor.
- Scrape the same page twice → same structured output. Non-determinism here means the extractor is depending on render timing.
- Point it at a page that returns a consent wall, one that returns a block page, and one that rate-limits. Each must be **reported as what it is**, not as an extraction failure.
- Ten pages in sequence → memory flat at the end, no orphaned Chromium processes.

### Debug

Scraping failures are rarely in your code. **Capture the response body and status
before touching a selector** — a block page, a consent wall, a rate limit, and a
genuine markup change all present identically as "the selector broke".

If a Mode 2 job is slow *and* expensive, check the model-call count first: the
usual cause is falling back to per-page model judgement when a selector misses,
which converts a cheap scrape into an expensive one silently. A selector that
stops matching should fail the run and ask for a redesign, not quietly summon the
model 14,000 times.

If memory climbs across runs the browser is not being closed on the error path;
check the `finally`, not the happy path. Orphaned Chromium after a crash means
the container is not being reaped — `docker ps` after a failed run.

Keep one saved copy of every page shape that broke, in the project's artifacts.
The site will change again, and the diff between the old snapshot and the new
page is the fastest possible diagnosis.

**Done when:** a scraping task completes unattended, escalates tiers correctly,
files structured output plus source snapshots as project artifacts, and cannot
see another project's session.

---

# STAGE 6 — MAKE IT SURVIVE

## S33 — Notification policy
*Size: 2 days.*

**Build** §17 exactly: silence on trivial capture; one line on short work; ack-plus-result on long work; one message per blocker with a working link; the weekly report. A repeated condition is a counter, not another page.

**Test** L10 — a trivial capture produces **zero** messages; a long task produces exactly two. Ten identical failures produce one notification with a count of ten. Every link in every notification actually opens the right page.

**Debug** If notifications arrive that should not, log the classification decision alongside the message and read a day of it — the bug is nearly always in classification, not in delivery. If they do not arrive at all, check the outbox state before the transport: a message stuck `pending` and a message that failed to send look identical from the phone.

**Done when:** a day of normal use produces only messages worth reading.

## S34 — Schedules, maintenance, improvement
*Size: 3 days.*

**Build** Schedules with overlap policy and misfire handling. The Maintenance project repairing what is safe and reversible and filing an Issue for the rest. The weekly Improvement scan (transcript msg 17) with one-tap approvals.

**Test** L14: overlap skipped, misfire >15 min skipped with an Issue, three errors pause the schedule, restart causes no duplicate fire. L19: simulate disk at 85%, an expired credential, a missed backup and a stuck browser — safe repairs happen, the rest become Issues, none of it wakes Enrique (N7). Force an Improvement run and confirm nothing activates itself.

**Debug** A duplicate fire after a restart means idempotency is keyed on something other than `scheduled_for`. A schedule that silently stops has usually hit its error count and paused itself — that is correct behaviour, but it must be visible in the console rather than only in a column. For Maintenance, confirm each auto-repair wrote what it did; a repair with no audit row is indistinguishable from a bug that fixed itself.

**Done when:** the system runs a full week unattended and the only messages are ones worth reading.

## S35 — Backup, restore, export
*Size: 2–3 days.*

**Build** Restic to B2 nightly including the database dump. Monthly restore drill recorded where the console can see it. One-command encrypted export of everything — schema, rows, artifacts, re-encryptable credentials, model registry, config, OpenClaw session — and a documented restore elsewhere.

**Test** L15: restore into a clean directory and verify projects, conversations, tasks, issues, schedules, a decrypted canary credential, and the model registry. **Then restore onto a different machine and boot it** — that is the transferability Enrique asked for in his first message, and a restore that has only ever been tested in place has not been tested.

**Debug** v1's backups did not contain the database and it went unnoticed. Assert on the dump's size and on a known row, not on the exit code.

**Done when:** a full restore runs on a second machine and Jarvis comes up with its memory intact.

## S36 — Full acceptance
*Size: 2 days.*

**Build** Nothing new. Run every gate in Part VIII, fix what fails, and freeze.

**Test** All five gates. Every narrative N1–N8. Every critical loop.

**Debug** A gate that passes on the fake harness and fails on the real one is the most likely outcome here, and it is information rather than a setback — the difference is exactly the assumptions the fake encoded. Record each one in `docs/DEBUG_NOTES.md` as you find it.

**Done when:** all gates green, with N1 green **against the real harness**, not the fake one.

---

# STAGE 7 — THE LAST THING

## S37 — WhatsApp
*Size: 2–3 days. Deliberately last. The number connects tomorrow; build everything up to the pairing now.*

When S36 is done, this is the only work left between here and a finished Jarvis.

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

## IV.0 The three core objects

The separation between these matters enormously, and getting it wrong is not
recoverable later — the provenance chain either exists from the first write or
it does not exist at all.

**Inbox Event — exactly what Enrique gave Jarvis. Immutable.**

A WhatsApp message, a voice note, a phone transcript, a console message, a file
upload, a scheduled firing, a webhook. Written before any model sees it and
**never edited, never corrected, never rewritten**. A bad transcription is fixed
by adding a derived record that supersedes it, not by changing the original — the
original is the evidence of what was actually said, and it is the only thing in
the system that cannot be reconstructed.

**Conversation — the ongoing context around something.**

Scoped to a project, or global for the Supervisor thread. Titled from its first
message, never named by hand. Holds his messages, Jarvis's replies, and agent
activity in one readable thread.

**Task — work Jarvis needs to perform.**

From "investigate the inventory timeout, reproduce, fix, test, open a PR" down to
"remember this".

### The relationships, and they are not one-to-one

```
Inbox Event ──1:N──> Conversation      (S3 splitting: one memo, three projects)
Conversation ─1:N──> Task              (one thread can spawn several pieces of work)
Task ─────────N:1──> Conversation      (or none, for a scheduled task)
```

**One conversation contains several tasks** over its life, and a task may be
trivial. Modelling these 1:1 is the mistake that makes both the console and the
routing wrong: it forces a new thread per piece of work, which shreds the context
that made the thread useful.

### Provenance is the point

Every derived record carries `origin_inbox_id` back to the immutable event that
caused it. That chain is what makes **"nothing is lost"** a checkable property
rather than a hope: from any task, PR or artifact, you can walk back to the exact
words Enrique said, and from any inbox event you can enumerate everything that
happened because of it.

A record that cannot name its origin is a bug, even when its content is correct.

## IV.1 Schema
37 tables, already migrated. The task table already carries `worktree_path`,
`branch`, `head_sha`, `harness`, `external_session_id`, `auth_profile_id` — the
data model anticipated the executor even though the code never arrived. Two objects the transcript names are **not** in the schema and are added in S18:
`resource_metrics` (host samples over time — today they are computed and thrown
away, so nothing can see a trend) and `activity_events` (an ordered per-project
feed; `audit_events` answers "who changed the system", which is a different
question).

New columns get the next migration number and a note in the commit saying what
depends on them. **Never edit an applied migration** — it has already run on the
box, and `schema_migrations` will not re-run it, so the file and the live schema
silently diverge. Always add a new one.

## IV.2 Task and issue state machines
As in `docs/STATE_MACHINES.md`. Illegal transitions are a 409 plus an audit row.

## IV.3 Error taxonomy

As in `docs/ERROR_TAXONOMY.md`. **Every class carries all eight fields**: type,
severity, retryability, retry policy, maximum attempts, backoff, recovery action,
and user-notification policy. A class missing one of those is a class that will
behave unpredictably exactly once, at the worst moment.

A new class is a deliberate addition with each field chosen on purpose — never a
string invented at a call site, which is how a failure ends up silent.

The plan checked its taxonomy against the twenty-eight failures the planning
conversation named. Twenty-five were covered; three were added:
`resource.cpu`, `dependency.unavailable`, and `agent.repeat` — the last being the
companion to II.3's liveness-vs-progress rule, because **identical progress is
not progress**.

**No silent task loss.** A terminal failure always has an Issue unless it was
cancelled.

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

## IV.7 Idempotency

Inbound integrations retry. **Deduplicate on the provider's external event id**,
always, before anything else happens to the event:

| Source | Retries because | Dedupe on |
|---|---|---|
| WhatsApp webhook | delivery retry | message id |
| Telnyx callback | callback retry | `call_control_id` + event type + sequence |
| OAuth callback | user refresh, double submit | state token, single-use |
| Scheduled run | restart mid-fire | `(schedule_id, scheduled_for)` |
| Internal HMAC post | client retry | request id |

A repeated delivery must never create a second task. The dedupe happens at
ingest, before classification and before any model, because a duplicate that
reaches routing has already cost money and may already have created work.

Where a source gives no usable id, derive one from a checksum of the payload plus
a time bucket — and record that it was derived, so a false match can be
recognised later.

## IV.8 Artifact lifecycle

`draft → generated → under_review → ready → approved → delivered`, with
`rejected` and `superseded` as exits (S17). A new version supersedes rather than
overwrites; overwriting destroys the comparison that makes review possible.

## IV.9 Audit

Every consequential action is attributable: who or what initiated it, project,
task, agent/model/harness, tool, timestamp, the approval if there was one, and
the result. At minimum — secret updated, production approval granted, model
changed, schedule changed, task cancelled, PR merged, provider added, connection
denied.

An audit row written after the fact is an audit row that will sometimes be
missing. Write it in the same transaction as the action wherever the storage
allows it.

## IV.6 Authorization levels

Three levels, fixed at planning time. **The model does not decide whether
approval is required — the policy engine does.** That sentence is the whole
control: a model asked to judge its own authority will, sooner or later, judge
generously, and it only has to do so once.

### Level 1 — Safe. Autonomous, always.

Read files, search, scrape, research, write code, run tests, create branches,
commit, open pull requests, read-only database analysis, produce artifacts.

No approval, no notification unless something failed. This is where Jarvis
should spend nearly all of its time.

### Level 2 — External but reversible. Per project policy.

Create a GitHub issue, send a draft, create a staging deployment, modify a dev
database, post internally.

Whether these need asking is a **project setting**, decided at onboarding (S26)
and recorded in the project's `AGENTS.md`. A personal side project may allow all
of them silently; a professional one may allow none.

### Level 3 — Production. Always requires Enrique, every time.

Merge to production, deploy to production, send external email, delete
production data, modify a production database, purchase anything, publish social
content, change infrastructure, rotate credentials.

A natural-language grant does **not** satisfy Level 3. Nor does a previous
approval for a similar action, nor a grant issued minutes earlier for the same
task. Point-of-action confirmation, every time.

The WhatsApp message for a Level 3 gate is short and complete:

```
TicketFlipping checkout fix is ready.
Tests: 31/31 passed
PR #814 · staging verified
Production deployment requires approval.
```

with Approve and Reject. Everything needed to decide is in the message; the link
is for the detail, not for the decision.

### Natural-language grants (Level 2 only)

"Fix this, PR it, merge it" pre-authorises named Level 1 and Level 2 actions for
**that task, that repository, that commit, that environment**, with an expiry.
It is invalidated by any of the eight conditions in S10. It can never reach
Level 3.

### Where this is enforced

In the broker, before the action — not in the prompt, not in the UI, and never
by asking the model to check itself. A Level 3 action reaching the broker without
a live approval is refused and audited, whatever the task believed it had been
told.

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

## VI.0 The model principle

**Open-weights models, hosted by a provider we pay. Not self-deployed, and not
free tiers.**

Both halves matter, and both are corrections of earlier plans:

- **Open weights, not closed.** The weights for the Supervisor and utility roles are publicly available, so the provider is a convenience rather than a dependency. If Fireworks doubles its price, disappears, or degrades, the same model is available elsewhere and the migration is a URL and a key — not a rewrite. This is what makes the portability Enrique asked for in his first message real rather than aspirational.
- **Hosted, not self-deployed.** Running these weights ourselves means a GPU box costing more per month than the entire budget, plus the operational burden of keeping it alive. Someone else runs the hardware and we pay for tokens.
- **Paid, not free.** The free-tier premise is dead and the evidence is in this repo: migration 008 measured the nominal free primary serving 9 turns out of 153, and Gemini serving 0. Free tiers rate-limit, retire models without notice, and cannot be depended on for a system meant to run unattended.

The exception is coding. The senior engineer and reviewer roles run on
**subscription CLIs** already paid for — Claude Code today, Codex and Cursor
registered for later. Those are flat-rate and their marginal cost is zero, which
is why the most expensive role in the system is also the cheapest to run.

## VI.1 The approved pool, and the line Jarvis may not cross

Jarvis has real autonomy over models — it must, or every provider hiccup becomes
an interruption. But that autonomy is **bounded by an approved pool**, and the
boundary is what makes the autonomy safe to grant.

**Inside the pool, Jarvis is free.** It swaps between approved models at will:
routing by role, by quota, by health, by cost. It never asks, and it should not.

**Outside the pool, it may recommend and nothing more.** Jarvis must never
autonomously:

- create a paid account
- add a payment method
- enable pay-as-you-go on an existing account
- send proprietary or confidential code to a provider not already approved for that project
- change a data-retention or privacy setting
- hand credentials to a new provider

The path out of the pool is fixed:

```
find candidate → benchmark it (S26) → recommend, with evidence
                                            ↓
                                     Enrique approves
                                            ↓
                                   Jarvis activates it
```

Every step of that is Jarvis's work except the approval, which is never
delegable and never inferable from a task grant. "Find me a better model" is
permission to search, not permission to sign up.

This is the model-layer instance of the immutable list in §59, and it holds even
under a broad authority grant: **a grant widens what Jarvis may do with what it
has, never what it may go and acquire.**

## VI.2 Quality floors, and when a degraded role is worth interrupting for

A provider hiccup is not news. A role that can no longer do its job is.

The transcript separates these cleanly, and the plan had collapsed them into
"raise an issue on failover", which produces a ticket per hiccup and trains
Enrique to ignore tickets.

**Situation A — a fallback exists and works.** Primary fails, fallback serves the
turn, work continues. Log the incident; say nothing. A thirty-second API wobble
is not an event in Enrique's day.

**Situation B — the role is degraded below its floor.** Every role carries a
**quality floor**: a minimum score on the S29 evaluation suite that a model must
meet to serve that role. When the remaining healthy pool for a role has nothing
above its floor, that is worth interrupting for — because the consequence is not
"slower", it is "worse work, silently".

The message says three things and offers two choices:

```
My Senior Engineer pool is degraded.
Model A is at quota, B is unavailable, C changed its API.
The only model left scores below the coding floor we set.

Continue with reduced capability, or add/replace a coding model?
```

State, consequence, choice. Not "an issue has been raised".

**Continuing below the floor is allowed but never silent.** If Enrique says
continue, every task run under a degraded role is marked as such on the task and
in its PR, so a change made by an under-qualified model is identifiable
afterwards rather than indistinguishable from the rest.

Floors come from measurement, not opinion: they are set from S29 benchmark
scores once the suite exists, and until then a role's floor is "a model that has
passed a real tool-enabled call", which is the weakest honest bar rather than an
invented number.

**Roles**: supervisor, utility, senior_engineer, reviewer, **research/browser**,
stt, voice_tts, vision, embeddings.

`research/browser` is its own role because its demands are the opposite of the
Supervisor's: high volume, cheap, latency-tolerant, and error-tolerant — a
misread page is retried, where a misrouted Supervisor turn is a broken
conversation. Routing them to the same model wastes money on one and quality on
the other.

## VI.3 What each role is selected for

The planning conversation named specific models for each role. Those names are
superseded — the free tiers are gone and the lineup has moved — but **what each
role is selected *for* has not changed**, and that is the durable half. Write
routing against these properties, never against a model's reputation.

| Role | Must be good at | May be weak at | Latency | Cost sensitivity |
|---|---|---|---|---|
| **supervisor** | tool calling, instruction following, staying in character, refusing cleanly | deep reasoning, long code | low — it is the conversation | medium; every turn pays |
| **utility** | short deterministic transforms, classification | anything requiring judgement | low | **high** — highest call volume |
| **senior_engineer** | long-horizon coding, root-cause reasoning, tests, scope control | speed, conversational polish | **none** — take the time | flat-rate subscription |
| **reviewer** | finding real defects, refusing to invent them | generating code | none | flat-rate; different family from the implementer |
| **research/browser** | search, navigation, source evaluation, running scripts, scraping, **recovering when a tool fails**, **holding an objective across many steps** | polish, exact phrasing | medium | **high** — many calls per task |
| **stt** | accented English, domain nouns, disfluency | everything else | low on the phone | low |
| **voice_tts** | one consistent pinned voice, natural prosody | — | **very low** — it is the call | metered per character |
| **vision** | reading documents and screenshots, tables | creative description | medium | medium |
| **embeddings** | stable vectors, cheap at volume | — | batch | must be near zero |

Two entries deserve their reasoning stated, because they are the ones most likely
to be routed lazily:

**research/browser** is agentic, not conversational. The two properties that
actually separate a usable model here from an unusable one are **recovering when
a tool fails** and **holding an objective across many steps** — not knowledge. A
model that answers beautifully and gives up when a selector misses is worse for
this role than a duller one that retries and remembers what it was doing.

**reviewer** must come from a **different family** than the implementer wherever
policy allows. A model reviewing its own family's output shares its blind spots,
and a reviewer that agrees with everything is a rubber stamp with a latency cost.

Candidates are proposed by Improvement and admitted to the pool (VI.1) only by
Enrique. Nothing in this table names a vendor, deliberately: the table should
still be correct in a year.

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
| Supervisor / utility | Hosted open-weights, one primary + one fallback (Fireworks today) | ~$5–10/mo |
| Senior engineer / reviewer | Claude Code on `anthropic_personal` | $0 marginal |
| STT | Groq Whisper — free tier is genuinely adequate for this one narrow job | $0 |
| Voice | ElevenLabs, pinned `voice_id` | existing |

**Budget**: VPS ≤ €20. Inference has a **$10/month soft budget and a $20/month
hard ceiling** — soft means Jarvis reports crossing it, hard means it stops
spending and parks. Total under €/$40 a month.

The subscriptions already own most of the capacity, so the paid gateway exists
for two things only: always-on cheap Supervisor operations, and catching coding
work when every subscription is exhausted. Metered spend stays off unless Enrique
sets a ceiling on that profile, and no route ever enables billing to rescue
itself.

**Jarvis manages its own models.** When a route dies it says so, proposes a
replacement, and asks for the one key it needs — it does not fail silently and it
does not enable billing to rescue itself.

---

# PART VII — OPERATIONS

## VII.1 Health and observability

Per-service health with incident history — a flapping service must not look
identical to one that never broke. Request IDs end to end. Unknown renders
`unknown`, never a plausible number.

**System Health shows the current condition; the activity feed shows history.**
Keeping those separate is what makes "is it healthy *now*" answerable at a
glance.

### What is monitored

| Group | Services |
|---|---|
| Core | OpenClaw gateway, Jarvis API, PostgreSQL, queue, scheduler, watchdog, backup |
| Execution | Supervisor, heavy runner, browser workers, coding harnesses, worktree manager, transcription |
| Communication | WhatsApp, Telnyx, ElevenLabs, the console |

**Per model provider**, all six: authentication state, availability, current
errors, rate-limit and quota state, **which roles depend on it**, and whether a
fallback is currently active. "Which roles depend on it" is the field that turns
a provider outage from a curiosity into a prediction of what is about to break.

**Infrastructure**: CPU, memory, disk, **disk-growth forecast**, I/O pressure,
network, containers and processes. A forecast rather than a level, because
S18's `resource_metrics` exists precisely so Maintenance can act before a
threshold rather than after it.

**Throughput**, which says whether the system is healthy in the sense that
matters: queue wait time, task throughput, worker restarts, provider failures.
A box with perfect CPU and a queue nothing has left in an hour is not healthy.

**Data protection**: latest successful backup, off-server backup status, last
restoration test, encryption and key health, log-redaction health. The last two
are the ones nobody checks until they matter.

**Security**: failed login attempts, project-isolation test results, unexpected
secret access, unexpected outbound network activity, pending security updates.

### Incident timeline

Every incident records: start and end, severity, affected projects and services,
recovery actions taken, whether Enrique was involved, a root-cause summary, and
the related issue. An incident with no recovery actions recorded is
indistinguishable afterwards from one that resolved itself, and those need very
different responses.

## VII.2 Self-healing (Maintenance project, seeded at boot)
Watches resources, database, queue, workers, browsers, harnesses, schedules,
backups, provider health, credentials, MCP servers, disk growth, stale
worktrees, orphaned containers, isolation checks, and config drift.

Repairs what is safe and reversible on its own. Everything destructive,
billing-related, production-impacting, or security-relevant becomes an Issue and
waits.

## VII.3 Backup

Restic to Backblaze B2, encrypted, nightly. A restore drill runs monthly and
records its outcome where the console can see it. **A backup nobody has restored
is not a backup** — already caught once in v1, when the backups did not contain
the database.

### What "authoritative state" means

Enumerated, because "the database dump" is what v1 thought it was backing up:

`Postgres dump` · **`OpenClaw's own state directory`** · projects · conversations ·
tasks · schedules · auth metadata · encrypted credentials · files · artifacts ·
memory and knowledge · model registry · **benchmarks** · configuration ·
**voice configuration** · project instruction versions

Three of these are the ones a backup script written from memory will miss:

- **OpenClaw's state directory.** It holds the paired WhatsApp session. Lose it and recovery means re-pairing by QR — a manual step, on Enrique's phone, at exactly the moment everything else is on fire. It is not Jarvis's data, which is precisely why it gets forgotten.
- **Benchmarks.** Losing them means every model's earned role (S29) has to be re-measured before routing can be trusted again.
- **Voice configuration.** A restored Jarvis that answers the phone in a different voice is a restored Jarvis that feels broken.

Backups must be consistent, encrypted, stored off-server, and **periodically
proven by restoration**.

### `jarvis export` and `jarvis restore`

Two documented commands, not a runbook of steps to follow carefully. Export
produces one encrypted bundle of everything above; restore brings it up
elsewhere. The commands are the deliverable — a procedure that only works when
performed carefully by someone who remembers the order is not a recovery plan.

Connections that genuinely cannot migrate (an OAuth grant bound to a host) become
**UserActionRequests after restore** rather than silent failures, so a restored
system tells Enrique exactly what it still needs.

### No critical state belongs to one vendor

State must never live exclusively inside Netcup, Composio, ElevenLabs, Telnyx,
the console host, or any single model provider. Infrastructure-specific
dependencies sit behind configuration and adapters, so moving to another VPS,
to AWS, or to a future GPU workstation is a migration rather than a rebuild.

This is the same argument as open weights in VI.0, generalised: **a dependency
you cannot leave is a decision you only get to make once.** The restore-onto-a-
second-machine test in S31 is what keeps it honest, because a portability claim
nobody has exercised is a portability claim that is false.

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

## The gates

Each gate is a set of tests with **numbers in them**. A gate written as a feeling
("capture works under load") passes whenever someone wants it to. The quantities
below come from the planning conversation and are the point of the exercise.

## Gate 1 — It acts *(blocks everything else)*
- **N1** the fix, end to end — console first, then voice note at S37
- **S8** seeded failing test → passing PR, in the suite and proven able to go red
- **L0b** the happy engineering loop
- **S1's five harness variants** each producing the right taxonomy class

## Gate 2 — It loses nothing
- **Ingestion at volume**: send **20 messages across 5 projects, rapidly, while a coding job is running.** All 20 persist, and all 20 are eventually routed to the correct project. Not 19.
- **L1** capture while busy, including a 10-second API kill mid-send
- **Duplicate delivery**: deliver the same webhook **5 times** → exactly one logical inbox event and one task (IV.7)
- **L2** restart the entire server with queued *and* running work → queued state survives in order; running work is reconciled or recovered
- **L3** kill the heavy worker mid-task → recovery resumes **without losing the user instructions attached to it**
- **N3** one input, several projects — the five-minute memo (S3)
- Five distinct mid-run failures (S11) each resumable

## Gate 3 — It stays inside its lines
- **Isolation**: a worker on project A attempts project B's secret → technical denial, not a policy note. Files, browser dir, connection name and model profile too (L9)
- **L6** two repos, distinct deploy-key fingerprints
- **L11** auth-profile isolation, denied before any HTTP leaves the box
- **L8** always-confirm blocked
- **Approval**: approve commit SHA A, then alter the branch → the old approval no longer authorises merge or deploy. All eight invalidation conditions (S10) verified individually
- **N6** production deploy refused without a live approval
- Search scoped to project A never returns project B (S18)

## Gate 4 — It is usable
- **N4** credential loop repaired from a phone, parked task resumes itself
- **L17** the six mobile journeys
- **S13** the console leads with work, not health
- **L10** notification brevity: zero messages for trivial capture, exactly two for a long task
- An output can be rejected with a note, revised, and the versions compared, without leaving the console (S17)
- **Expired connection**: expire a GitHub credential → **one** deduplicated issue, and **every affected task links to it**. Reauthenticating closes the issue and resumes all of them, not just the one that hit it first
- **Stuck worker, visible**: hang a worker deliberately → the task timeline in the console shows stalled → recovering → resumed. The watchdog's intervention must be legible in the UI, not only in the database
- **Client security**: inspect browser traffic and client storage → no provider secret, no OpenClaw admin token, no database credential, no secret value in logs or analytics

## Gate 5 — The phone is dependable
- **Ten consecutive calls**, three with a forced provider failure, all ending cleanly with a stored transcript
- The two historical bugs — self-transcription and the runaway recording loop — covered by permanent regression tests
- Barge-in stops playback within a beat, at any point in a reply
- A call produces a real task and a real PR (S22)
- **L13** outbound refused at 20:00, allowed Saturday 10:00; a security incident at 02:00 rings and a production outage at 02:00 does not; the six calling reasons trigger and nothing else does
- **L12** raw call audio gone at 7 days, transcript retained

## Gate 6 — It survives
- **Provider exhaustion across an entire role**: force rate limiting on *every* model in one role → approved fallbacks take over, then Jarvis asks for help. It does not silently stop and it does not enable billing to rescue itself
- **L4** model failover with conversational continuity — same conversation id, no metered enablement. **An issue is raised only if the role is materially degraded**, never for a routine failover that the fallback absorbed. A ticket per failover trains Enrique to ignore tickets
- **Backup**: destroy a disposable test installation entirely and restore from backup → projects, conversations, schedules, credentials, queue metadata and configuration all return. **Destroy, not simulate** (L15)
- **L14** schedules: no duplicate fires across a restart
- **N7** self-repair at 03:00 without waking him
- **N2** a question answered weeks later with a citation, across a restore
- **N8** the weekly report arrives and activates nothing on its own

## The V1 completeness list

Every one of these must have been *demonstrated*, not merely implemented:
durable capture · project routing · simultaneous requests without loss · queue
processing · engineering execution · PR creation · scheduling · WhatsApp · voice
notes · phone calling · Control Center · authentication · secrets · connections ·
model failover · watchdog recovery · crash recovery · approval enforcement ·
backups · restore test · monitoring · artifact tracking · project isolation ·
error management.

**V1 is not complete because Jarvis can answer messages.**

## The standing rules

1. **No test passes by asserting a database row where it should assert an effect.** If it does not prove something changed in the world, it does not count.
2. **Every test must have been seen to fail once.** Break the thing deliberately, watch it go red, then fix it. An assertion that cannot fail is decoration.
3. **A gate closes only with evidence attached** — a transcript, a task id, a log excerpt, a screenshot. "I checked" is not evidence.
4. **A test with a number in it beats a test with an adjective in it.** Twenty messages across five projects is falsifiable; "handles load" is not.

---

# PART IX — HOW TO WORK

One agent, thirty steps, in order. This part is the discipline that keeps that
honest.

## IX.1 The loop for every step

Read the step. Build it. **Test it, including the failure paths.** Debug until
the "Done when" line is observed. Commit with the evidence in the message. Then,
and only then, read the next step.

Do not batch steps. Do not start S6 because S5 is "basically done". Basically
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
- **Do not point an autonomous loop at the acceptance suite until S8 exists.** A loop optimises what the suite measures; before S8 the suite measures plumbing.
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
| **1 — It acts** | S1–S8 | A sentence becomes a pull request. **The only stage that is not optional.** | 12–15 days |
| **2 — It is trustworthy** | S9–S12 | Review, grants, recovery, proven isolation | 7–8 days |
| **3 — It is visible** | S13–S18 | A console that shows work, repairs credentials, controls output quality, and can be searched | 15–17 days |
| **4 — The phone is reliable** | S19–S24 | A call you can depend on and hold a real conversation with, and Jarvis calling you | 14–17 days |
| **5 — It reaches** | S25–S32 | Routing, onboarding, config-by-voice, runtime interface, model evals, memory, Composio, MCP, scraping | 22–27 days |
| **6 — It survives** | S33–S36 | Notifications, schedules, self-repair, restore, acceptance | 9–11 days |
| **7 — WhatsApp** | S37 | The last thing. Voice note in, PR back. | 2–3 days |

**Total: roughly 81–98 working days** for one agent working sequentially, with
testing done properly at every step rather than deferred.

That number is honest rather than encouraging. Two things make it smaller:
Stage 1 alone is already a usable Jarvis for engineering work, and Stages 3–6
are each independently shippable — none of them has to be finished before the
system is useful.

## The order is not arbitrary

- **S1 first** because every step after it is tested through the fake harness. Building it later means everything before it was built blind, which is exactly how the runner came to be written and never run.
- **S2 and S4 next** because they are the critical path. Until a message can become a task and a task can spawn a harness, no other work can be demonstrated at all.
- **Stage 2 before Stage 3** because a console showing untrustworthy work is worse than no console.
- **Stage 4 after Stage 1** because the phone becomes genuinely useful only once the desk can *do* something. A reliable call to a system that cannot act is a pleasant dead end.
- **S37 last** by request: the number connects tomorrow, and everything up to the pairing is built and tested before then.

## What "finished" means

When S37 is green, this is true:

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
| Phone calls, both directions (06, 07, 15) | S19–S24 |
| Jarvis can call me (06, 15) | S23 |
| Five-second turn-taking on calls (01) | S20 |
| WhatsApp voice notes (01, 15) | S37 |
| Nothing I say is ever lost (15) | S2, S11, S37, Gate 2 |
| Testing, trying, debugging built in | III.0, IX.2, IX.4, every step |
| Jarvis tests models and picks its own primaries (09) | S29 |
| Change any project's setup from any channel (17) | S27 |
| Weekly scan of the AI world, one-tap approve (17) | S34 |
| Maintenance project that heals the system (17) | S34 |
| Dump anything, ask about it later (01) | S30, N2 |
| Never mix connections between projects (01, 20) | S5, S12, S31 |

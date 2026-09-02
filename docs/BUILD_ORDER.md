# Build order — SUPERSEDED

> **Superseded by `docs/JARVIS_MASTER_PLAN_V2.md`. Do not sequence work from this
> file.** Its Step 0–6 numbering predates the plan's S1–S37 and does not map onto
> it; two documents with different step numbers, both claiming to supersede
> `FIRST_SLICE.md`, is how someone ends up building the wrong list.
>
> Kept because **the six decisions below are still the decisions**, and this is
> where they were made and argued. The master plan carries them forward; this is
> the record of why.

Date: 2026-09-01. Written after `docs/GAP_ANALYSIS.md`, before the master plan
existed.

`FIRST_SLICE.md` deferred worktrees, GitHub keys and harness spawn. That deferral
is why Jarvis does no work. This document resequences around one rule:

> **Nothing ships before the executor except what the executor needs.**

## Decisions taken

| # | Question | Decision |
|---|---|---|
| 1 | Start over? | **No.** Keep the 8,453 lines. Build the executor. |
| 2 | Where does the harness run? | **Host systemd runner as `jarvis`.** ADR 015. |
| 3 | Which harness? | **Claude Code first.** *Revised by the plan:* S28 adds the `AgentRuntime` interface and a second adapter, because the evaluation suite has nothing to compare until two exist. |
| 4 | Which models? | **Paid open-weights for Supervisor, subscription for Engineer.** Free-tier chain is dead. |
| 5 | What gets frozen? | Ops, observability, security, backups, notifications. **No further work.** |
| 6 | What proves done? | One acceptance test: seeded repo, failing test in, merged PR out. |

### 3 — why Claude Code only

`claude -p --output-format stream-json` emits structured events that map directly
onto `task_attempts` / `task_checkpoints` / the Work view, it reads `AGENTS.md`
from the repo (which §28 already assumes), it drives git natively, and its
permission modes map onto the §13 authorization levels that already exist in the
schema.

One harness wired properly beats three wired halfway. Once the runner contract
exists, a second adapter costs roughly 10% of the first — add Codex when there is
a reason, not before.

Expect to hit subscription usage limits on a personal plan running unattended.
That is what the existing route-health and degrade machinery is genuinely good
for: repoint it from "free tier 429" to "harness limit reached", park the task,
notify, resume.

### 4 — the model chain, shrunk

| Role | Route | Cost |
|---|---|---|
| Supervisor | Fireworks, one open-weights primary + one fallback | ~$5–10/mo at this volume |
| Engineer | Claude Code on `anthropic_personal` | $0 marginal |
| STT | Groq Whisper free tier — genuinely adequate for this job | $0 |
| TTS | ElevenLabs, already paid | existing |

Delete the rest. 16 registered models across five providers exists to survive a
free-tier constraint that no longer applies. Two healthy routes beat sixteen
half-probed ones, and it removes a large share of `catalog.ts`.

### 5 — what to stop touching

Frozen. No tickets, no ticks, no refactors, no matter how tempting:

- error taxonomy, issue dedupe, issue auto-resolve
- notification outbox, brevity rules, quiet hours
- backups, restore drills, restic
- host metrics, health incidents, service coverage
- ADR conformance sweeps
- console polish that is not the Work view

These are done and they are good. Every hour spent here is an hour the system
still cannot open a PR.

## Sequence

Each step ends in something demonstrable. Do not start the next until the current
one is demonstrated.

### Step 0 — commit (today, 10 minutes)

47 uncommitted files, one commit in the repo. Two days of work is unversioned.
Commit before anything else touches the tree.

### Step 1 — `task_create` (half a day)

Add the Supervisor tool. Message → task, with project, lane, priority, objective.
Route heavy work to `lane='heavy'`.

**Demo:** send "look at repo X and fix the failing test" in the Control Center;
a heavy task appears in the queue with the right project attached.

### Step 2 — the runner skeleton (1 day)

`deploy/jarvis-runner.service` + `src/runner.ts`. Claims heavy tasks, creates a
worktree, spawns `claude -p` with a fixed trivial prompt, streams stdout into
`task_attempts`, writes a checkpoint, releases the lease.

No PR yet. No review. No retries beyond what the watchdog already gives.

**Demo:** a heavy task reaches `succeeded` with real harness output visible in the
Work view. This is the moment Jarvis stops being a chatbot.

### Step 3 — the engineering loop (2–3 days)

Fill in §27: load project `AGENTS.md`, run the harness against the objective,
push a branch through the project deploy key, open a PR via
`githubCreatePullRequest`, post a short WhatsApp/console update.

Skip for now: independent review by a second family (§29), the eval suite (§30).
They are real, they are not first.

**Demo:** WhatsApp message in → PR link out.

### Step 4 — make the console show work (half a day)

Command Center leads with active and recent **work**, not health. System lane
collapsed by default. Health becomes a strip, not the page.

The console currently leads with health because health was all there was. Once
step 3 lands, that is no longer true and the UI should stop implying it.

### Step 5 — the acceptance test that matters (half a day)

Seeded repo, one failing test. Assert Jarvis opens a PR that makes it pass.

Add this **before** pointing any autonomous loop at the suite again. A loop
optimizes what the suite measures; right now the suite measures plumbing, which
is exactly how 31 overnight ticks produced zero progress on Phase 4.

### Step 6 — integrations (ongoing, after the above)

`packages/integrations` is an empty README. Composio adapter, MCP client, browser
+ scraping. Requested in the very first planning message, still at zero.

Order within this step: browser/scraping first (named explicitly and repeatedly),
then Composio, then generic MCP.

## Not in this sequence

WhatsApp pairing, Telnyx phone, voice, the weekly Improvement job. All specified,
all fine, all worth doing — after Jarvis can do work. A voice interface to a
system with nothing to report is the same shallow feeling in a nicer wrapper.

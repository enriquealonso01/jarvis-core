# Debug notes

Bugs that cost real time. Each one is here so it is found in minutes next time
instead of hours.

**The rule** (Master Plan III.0 §6): when something breaks twice for the same
reason, or once expensively, it gets an entry here **and** a regression test
before the fix is committed. An entry without a test is a note; an entry with a
test is a fix that stays fixed.

Format: symptom → cause → fix → the general lesson.

---

## Phone

### Jarvis transcribed its own greeting as if the caller had said it
**Symptom:** every call opened with Jarvis answering a question nobody asked.
**Cause:** recording started on `call.answered`, at the same moment as the
greeting playback, so the greeting went down the line and straight back into
Whisper.
**Fix:** recording starts on `call.speak.ended` / `call.playback.ended`, never on
`call.answered`.
**Lesson:** on a phone line, anything you play is also something you can hear.
Arm listening only after speaking has finished.

### One utterance produced several replies, and the call ran away
**Symptom:** a single sentence from the caller produced multiple transcriptions,
each producing a reply, each arming more recording sessions. Five recordings for
one turn.
**Cause:** every reply's own `playback.ended` armed another listening session,
including the playbacks that were themselves replies.
**Fix:** only the greeting arms listening, gated on `client_state`.
**Lesson:** in an event-driven call flow, the events your own actions generate
look identical to the events the caller generates. Tag them — `client_state` is
the only reliable discriminator — and never let a self-generated event drive the
state machine.

---

## Workers and the queue

### The heavy lane never ran anything, for the entire life of v1
**Symptom:** every request to do real work sat in `waiting_for_provider`. The
console showed only maintenance.
**Cause:** `worker.ts` claimed heavy tasks and immediately parked them with
"harness runner not built yet". The runner was out of scope in `FIRST_SLICE.md`.
**Fix:** `src/runner.ts` plus ADR 015; the container worker no longer claims from
the heavy lane at all.
**Lesson:** a deferral written into a scoping document is invisible six weeks
later. If the thing being deferred is the reason the system exists, it is not a
deferral, it is a cancellation.

### Task claiming silently broke and the suite stayed green
**Symptom:** no task was ever claimed after a queue-fairness change.
**Cause:** `FOR UPDATE` on a query with a `LEFT JOIN` — Postgres rejects locking
the nullable side of an outer join. It needed `FOR UPDATE OF t`.
**Fix:** lock the task table explicitly.
**Lesson:** two lessons. Postgres row locking and outer joins interact badly. And
a 33-test suite that does not notice the queue has stopped is testing the wrong
things — see Master Plan VIII.0.

### Watchdog tickets were opened and never closed
**Symptom:** the Issues page filled with `worker.crash` rows nobody could act on.
**Cause:** the dedupe key was the task id, but `ERROR_TAXONOMY.md` dedupes
`worker.crash` by **lane**. Every stall opened a fresh ticket that nothing would
ever resolve.
**Fix:** key on lane, and resolve the ticket when the recovery succeeds.
**Lesson:** a dedupe key that is too specific is the same bug as no dedupe at
all. If a ticket has no closing condition, it is a log line pretending to be a
ticket.

---

## Credentials and routing

### Every model route failed and the reason was unknowable
**Symptom:** 9 of 12 supervisor turns got no reply. The log said `429`, `404`,
`400`, `500`.
**Cause:** hardcoded model ids the providers no longer served — and only the
status code was stored, never the provider's error body. The body said
`no longer available to new users. Please update to gemini-3.6-flash`.
**Fix:** routes come from `model_registry`, every candidate is probed with a real
tool-enabled call before it is marked approved, and the actual error body is
recorded.
**Lesson:** **store the response body, not the status code.** A bare status turns
a five-minute diagnosis into an afternoon. And a model appearing in a provider's
`/models` list is not evidence that it can be called.

### Host logins were completed and Jarvis kept asking for them
**Symptom:** the same setup blocker paged forever after the login was done.
**Cause:** `auth_profiles.harness_auth_dir` gated the blocker, and nothing ever
wrote it.
**Fix:** the worker detects the credential file the CLI writes on success and
reconciles the column every pass, not only on transition.
**Lesson:** if a column gates behaviour, something must write it. Grep for
writers of every column you depend on. Reconcile state every pass — gating the
write on "something changed" leaves the first pass correct and the second wrong.

---

## Backups and deploys

### The backups did not contain the database
**Symptom:** found during a restore drill. Everything restored except the only
part that mattered.
**Cause:** the backup covered the filesystem; the dump was never produced.
**Fix:** dump inside the backup script; the drill asserts the dump's size and a
known row.
**Lesson:** a backup nobody has restored is not a backup. Assert on **contents**,
never on the exit code.

### Deploying the console 404'd the whole site
**Symptom:** after a successful deploy, every page was missing.
**Cause:** the deploy replaced `/opt/jarvis/control-center` with `mv`, swapping
the inode under Caddy's bind mount. The container kept serving a directory that
no longer existed.
**Fix:** `rsync --delete` the *contents*; never replace the directory itself.
**Lesson:** a bind-mounted directory is an inode, not a path. Anything that
replaces it needs the container recreated.

### The runner had no memory ceiling
**Symptom:** none yet — found by audit before it bit.
**Cause:** ADR 015 moved the heavy worker out of Docker onto the host. Every
other component is a container with a `mem_limit`; the runner was a bare systemd
unit, so the single largest slice in ADR 007's budget was the only unbounded
process on a 16 GB box. A runaway harness would have OOM-killed Postgres.
**Fix:** `MemoryHigh=3584M`, `MemoryMax=4096M` on the unit.
**Lesson:** when you move a component across an isolation boundary, re-check
every limit the old boundary was providing for free.

---

## Process

### Thirty-one overnight ticks produced no progress on the thing that mattered
**Symptom:** 2,590 lines of changelog, 33/33 tests passing, and the system still
could not open a pull request.
**Cause:** the loop was pointed at an acceptance suite that only measured
plumbing, so it improved plumbing — outbox, health signals, artifact endpoints,
ADR sweeps — while the heavy lane stayed parked.
**Fix:** S7 must exist and be green before any autonomous loop is pointed at the
suite again.
**Lesson:** an optimiser improves what you measure. If the measurement does not
include "it did the job", the optimiser will never make it do the job.

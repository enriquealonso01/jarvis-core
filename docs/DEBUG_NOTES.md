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

## Test environment

### The API could not start anywhere except the box
**Symptom:** on a clean dev volume the API container exited immediately with
`ENOENT: no such file or directory, open '/var/lib/jarvis/keys/login-once.txt'`.
**Cause:** `ensureBootstrapUser` writes the first-login file into
`JARVIS_ROOT/keys`, and nothing in the application ever created that directory —
`scripts/phase0-host.sh` did, once, on Netcup. Every environment that was not
the production box was therefore unbootable, and nobody had noticed because
nobody had ever started it anywhere else.
**Fix:** `fs.mkdirSync(path.dirname(oncePath), { recursive: true })` before the
write.
**Lesson:** a bootstrap step that lives in a provisioning script is a hidden
prerequisite. If the application needs a directory, the application should
create it — otherwise "works on the server" is the only environment there is.


### The seed did not reset what a test had created, so tests changed each other
**Symptom:** after a routing sabotage was reverted and the suites re-run, S2 and
S3b both failed on project counts, and S3b reported `task in hindenburg` — a
project no fixture defines.
**Cause:** `dev-seed.ts` truncated the work tables but never `projects`. A
sabotage round had created a project as part of proving an assertion could fail;
it survived every subsequent seed, and from then on the world each test ran in
was not the world the fixture described.
**Fix:** the seed deletes every non-system project that is not one of its own
three fixtures.
**Lesson:** "reset to a known state" has to include the tables a test can write
to, not just the ones it is expected to. Anything a test can create, the seed
must be able to remove — otherwise the first test to leave a trace silently
becomes part of every later test's setup.

### A fixture keyed on a phrase swallowed every longer message containing it
**Symptom:** a message asking for work *and* a question routed as a pure
question, and the work half vanished. It read exactly like a segmentation bug in
the router.
**Cause:** the fake model matched fixtures with `Array.find`, so the first
fixture whose `match` appeared anywhere in the message won. A fixture keyed on
"how does our deploy work" matched a longer sentence that merely contained it.
**Fix:** longest match wins, and test sentences avoid containing another
fixture's key verbatim. The rule helps but does not remove the hazard: a longer
key can still be a substring of a shorter test message's superset.
**Lesson:** substring-matched fixtures are order- and length-sensitive in ways
that look like product bugs. When a routing test fails in a way the code cannot
explain, check which fixture actually matched before reading the code.

### TRUNCATE CASCADE quietly deleted every conversation
**Symptom:** after the S2 seed ran, `POST /api/conversations//messages` — with an
empty id — 500'd with `invalid input syntax for type uuid: ""`. It read like a
routing or auth bug; the conversation table was simply empty.
**Cause:** `conversations.created_from_inbox_id` has a foreign key to
`inbox_events`. The seed truncates `inbox_events`, and `CASCADE` truncates every
table referencing it — so wiping the inbox wiped every thread, including the one
migration 002 seeds for the console.
**Fix:** the seed recreates the console thread explicitly, and says so in a
comment, rather than assuming the truncate list is the whole blast radius.
**Lesson:** `TRUNCATE ... CASCADE` follows FKs *inbound*, so the tables it
destroys are not the ones you named. Before trusting a truncate list, ask
Postgres: `SELECT conrelid::regclass, pg_get_constraintdef(oid) FROM
pg_constraint WHERE confrelid = '<table>'::regclass`.

### The sabotage did not compile, so the build failed and the old image kept running
**Symptom:** a deliberate break to `task_create`'s lane produced 24/24 green —
the second time in two steps that a see-it-fail pass silently proved nothing.
**Cause:** the sabotage was a type error, `pnpm build` failed inside the Docker
build, and `docker compose up --build` was piped through `tail -1`, so the error
scrolled past and the container came back up on the previous image.
**Fix:** typecheck the sabotage before building, and grep the build output for
`error` and `Built` instead of tailing it.
**Lesson:** a see-it-fail pass has two ways to lie — the patch not applying, and
the patched code not being what is running. Confirm the sabotage is in the file
*and* in the artifact under test before believing a green result.

### A whole test run went red on a UUID that was perfectly valid
**Symptom:** every assertion in the first S1 run failed with
`invalid input syntax for type uuid: "1f40b83c-...-faa6a5941b1d
INSERT 0 1"`.
The id looked correct in the error message, which is what made it slow.
**Cause:** `psql -tA` suppresses headers and alignment but NOT the command tag.
`INSERT ... RETURNING id` prints the id and then `INSERT 0 1` on the next line,
so the captured variable was two lines, not one.
**Fix:** filter the value the test actually wants —
`| grep -oiE '^[0-9a-f-]{36}$' | head -1` — rather than trusting `-tA` to
produce one clean line.
**Lesson:** when a value that looks right is rejected, print it with delimiters
around it before doubting the parser.

### A deliberate sabotage silently did nothing, and the test "passed"
**Symptom:** during the see-it-fail pass for S1, the `ok` variant was sabotaged
so the fake harness would write no file — and the test stayed green. Reading the
green result as "the test cannot detect this" would have been wrong; reading it
as "the assertion is decoration" would have been worse.
**Cause:** the patch was applied by a Python snippet whose search string
contained backslash escapes, and the surrounding shell heredoc had already
consumed them. `str.replace` found nothing and returned the original text
without complaining.
**Fix:** every scripted edit asserts that its anchor was found before writing,
and anchors avoid backslashes entirely.
**Lesson:** a silent no-op patch is indistinguishable from a test that cannot
fail. `str.replace` and `sed` both fail quietly; make the edit assert, then
confirm the sabotage is present in the file before drawing a conclusion from the
run.

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

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

### The dev harness profile evaporated the first time the worker ran
**Symptom:** the second half of the S4 recovery test failed with the task on
`waiting_for_provider` — no usable subscription login — on a stack where the
seed had just installed one.
**Cause:** `detectHostLogins` reconciles every profile on every worker pass and
clears `harness_auth_dir` unless a non-empty `.credentials.json` is present
(`HOST_LOGIN_PROOF`). The dev seed created the directory but not that file, so
the fixture was only ever valid because no worker had run in dev before. The
first test that needed the watchdog also started the worker, and the heavy lane
went unusable mid-suite.
**Fix:** the seed writes a placeholder `.credentials.json` — a marker, not a
credential; the fake harness never reads it.
**Lesson:** a fixture that satisfies the code you happen to be testing is not a
fixture. Reconcilers run on everything, so the seed has to satisfy the
reconciler, not just the reader.

### The Supervisor answered the wrong message when two arrived at once
**Symptom:** three messages sent together produced tasks for "burst one",
"burst three" and "burst three" — one message answered twice, another lost
entirely. About one run in ten, so it looked like flakiness rather than a defect.
**Cause:** `runSupervisorTurn` appended the message it was answering only if the
recent-history window did not already contain it:

    if (!messages.some((m) => m.role === "user" && m.content === userPayload)) {
      messages.push({ role: "user", content: userPayload });
    }

The history *always* contains it — `ingestUserMessage` stores the user message
before calling the Supervisor — so the guard almost always skipped the push, and
the turn ended on whatever the history had last. In sequence that is the same
message and nothing is wrong. Concurrently, the window is shared, so a turn could
end on a sibling's message and answer that instead.
**Fix:** the message being answered is filtered out of the history and appended
explicitly, so it is last and appears exactly once. 65 burst rounds clean after;
restoring the old guard reproduced the loss on round 1.
**Lesson:** a dedupe guard that is *usually* true is a branch that is usually not
taken, and its behaviour when it is taken had never been exercised. Concurrency
did not create this bug — it revealed a turn that had never been asked to be
sure which message it was answering.

### A fixture that lied about being GitHub-linked parked every successful run
**Symptom:** the moment S7 wired pull-request opening into the runner's success
path, four suites regressed: every heavy task that had been reaching `succeeded`
now sat at `waiting_for_provider`, blaming a missing GitHub API credential.
**Cause:** not the new code. `dev-seed` created dev-sandbox with
`github_owner='jarvis-dev'`, a made-up value, so the project looked GitHub-linked
while its real origin was a local bare repo. Every completed run therefore tried
to open a pull request against a repository that does not exist, and correctly
parked for the credential it would have needed.
**Fix:** the fixture stops pretending — dev-sandbox has no `github_owner` or
`github_repo`, because it has a local origin. The park path is still exercised,
by iso-alpha, which is genuinely linked to the local SSH host.
**Lesson:** placeholder values in a fixture are claims. A field filled in "so it
looks realistic" is indistinguishable from a real one to the code reading it, and
the failure surfaces far from the fixture, looking like a product bug.

### `info/exclude` lives in the COMMON dir, and the first real run proved it
**Symptom:** the first successful real-bug run committed `.jarvis/outcome.json`
and `.jarvis/phases.jsonl` into the project's history — Jarvis's own bookkeeping,
in Enrique's repository, in the diff a human is meant to review.
**Cause:** the previous fix resolved the gitdir with `rev-parse
--absolute-git-dir`, which for a worktree returns `.git/worktrees/<name>`. git
does not read excludes from there. It reads `$GIT_COMMON_DIR/info/exclude` — the
main `.git/info/exclude`. So the file was written, to a path git never consults,
and the second fix failed exactly as silently as the first.
**Fix:** `rev-parse --path-format=absolute --git-common-dir`, plus an assertion
in the S6 suite that no path under `.jarvis/` appears in the branch's tree.
**Lesson:** two wrong answers about where git keeps something, in a row, both
silent. When a write "succeeds" but has no effect, the next question is not
"did it write" but "does anything read that path" — and the test should assert
the effect, not the write.

### The harness could edit but not execute, so its loop could never finish
**Symptom:** the first real engineering run reproduced the bug, found the root
cause, wrote the fix AND the regression test — then stopped and reported itself
blocked, having failed to run `node --test`, `node -e`, or even `node test/...`.
**Cause:** the runner spawned `claude` with `--permission-mode acceptEdits`,
which permits file edits but not command execution. A workflow whose `checks`
phase runs the project's test command can never pass it.
**Fix:** `bypassPermissions`, which is what the plan already implies — it says
containment is the unix user and the config dir, "not this flag". To keep that
true now that the harness can execute, the escape guard was widened to read Bash
commands as well as path arguments, flagging absolute paths under JARVIS_ROOT
that fall outside the worktree.
**Lesson:** the honesty machinery worked perfectly and reported a real blocker —
but the blocker was our own misconfiguration. When an agent says it cannot do
something, check what you actually allowed it to do before believing the task is
hard.

### A worktree's `.git` is a file, so the exclude was never written
**Symptom:** a run that deliberately changed nothing still recorded
`changed: true`, and the "declined, made no commit" assertion failed.
**Cause:** the runner appends `.jarvis/` to `<worktree>/.git/info/exclude` so its
own scratch never enters the project's diff. In a **worktree**, `.git` is a FILE
pointing at the real gitdir, not a directory — so the `mkdir` failed with
ENOTDIR, the failure was swallowed by a `.catch()`, and the exclude silently did
not exist. Jarvis's bookkeeping then showed as untracked, and `git add -A` would
have committed it into Enrique's repository.
**Fix:** ask git where its directory is (`rev-parse --absolute-git-dir`) instead
of assuming, and additionally exclude `.jarvis` by pathspec when computing the
diff, so one mechanism failing cannot make an untouched repo look changed.
**Lesson:** `.git` is only a directory in the main clone. Any path built as
`<dir>/.git/...` is wrong in a worktree, a submodule, or a separate-gitdir
checkout — and a swallowed `.catch()` turns that into a silent no-op rather than
an error.

### Phases were recorded only on the success path, so crashes lost them
**Symptom:** the S6 resume test found zero phases after a run that had announced
four of them, so there was nothing to resume from.
**Cause:** the final drain of `.jarvis/phases.jsonl` sat after the failure
branches. A run that exited non-zero returned before reaching it, and anything
announced between the last heartbeat and the exit was dropped — which is exactly
the run whose phases matter most.
**Fix:** drain immediately after the harness returns, before any branching.
**Lesson:** cleanup that only runs on the happy path is not cleanup. Put it
where the control flow cannot route around it.

### A two-phase key test regenerated the keys between the phases
**Symptom:** the S5 isolation test's cross-project assertion passed, but so did
its control — alpha could not reach its OWN repo either. A test where everything
fails is not proving isolation, it is proving nothing.
**Cause:** the test ran in two phases (generate and authorise keys, restart sshd,
then assert) and used timestamped project slugs. Phase 2 created *new* projects
with *new* keys the server had never been told about, so every connection was
refused for the ordinary reason.
**Fix:** deterministic slugs, and phase 2 reads back the key phase 1 stored
rather than making one.
**Lesson:** an isolation test needs a control that succeeds. "A cannot reach B"
means nothing unless "A can reach A" is green in the same run — otherwise the
first broken thing in the setup silently satisfies the assertion.

### A restart threw away the run it was supposed to preserve
**Symptom:** found by S4's own on-box test, first time it ran for real.
`systemctl restart jarvis-runner` mid-run left the task `failed_terminal` with
`harness.crash` and `harness exited 143`. The whole run's work was gone — the
exact opposite of the step's Done-when, "a mid-run restart recovers instead of
losing work".
**Cause:** `KillMode=control-group` is systemd's default, so SIGTERM goes to
every process in the unit's cgroup — the `claude` child included. It died with
143, and the runner had no way to tell its own shutdown from a harness that
crashed on its own. It concluded the task on behalf of a process that was about
to stop existing.
**Fix:** a module-level `draining` flag set by the SIGTERM/SIGINT handler. When
the harness exits while draining and nothing else has gone wrong, the runner
writes the checkpoint, records the attempt as drained, and **returns without
transitioning** — leaving the task `running` with a stale heartbeat so the
watchdog does `stalled -> recovering -> queued` from the checkpoint. Covered by
`scripts/s4-drain-test.sh`.
**Lesson:** a worker that can be told to stop needs to know it was told. Without
that, every graceful shutdown looks exactly like a crash — and the difference
decides whether work is requeued or destroyed.

### `kill -TERM -1` does not signal PID 1, so the repro missed the bug
**Symptom:** the first dev reproduction of the above showed the task failing —
but for the wrong reason. The runner never entered its drain path, and the fix
appeared not to work.
**Cause:** two wrong repros in a row. `docker stop` signals only PID 1, so the
harness survived and the runner never saw its child die. Then `kill -TERM -1`
signals everything *except* the caller and PID 1 (Linux excludes init), so the
harness died and the leader did not — the reverse.
**Fix:** walk `/proc` and signal every pid, leader included, which is what a
cgroup-wide TERM actually does.
**Lesson:** "signal everything" has at least three meanings and only one of them
matches systemd. When reproducing a signal-delivery bug, verify *which* process
actually received the signal before concluding anything about the code.

### A failed harness run was recorded with a blank summary
**Symptom:** none in production yet — found by doing what the plan says and
capturing one real `claude -p --output-format stream-json` run before trusting
the parser.
**Cause:** a failing run exits 1 and emits
`{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}`.
The runner did `outcome.result ?? \`harness exited ${code}\``, and `??` does not
fire on an empty string — so the fallback never ran and the task's summary, the
issue evidence and the notification all carried nothing at all. A failure nobody
can explain without opening the transcript, which is the one thing the required
action tells you to do.
**Fix:** the failure explanation is built in descending order of usefulness —
the result text, else the `subtype`, else the stderr tail, else the exit code —
and an empty string counts as nothing at every step. `subtype` and `is_error` are
now parsed and land on the checkpoint. `is_error` is checked alongside the exit
code, so a harness that ever reports an error while exiting 0 is not recorded as
a success. Covered by the `fake:errorresult` variant, which replays the captured
shape byte for byte.
**Lesson:** `??` is not `||`. For a field that a real producer can send as `""`,
they are different fixes and only one of them is right. And the plan was right
that the event shape had to be captured rather than assumed — the happy path was
exactly as expected, and the failure path was not.

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


### A test changed the API container's environment and every later suite lied
**Symptom:** after S3c passed, S3b went 17/37, S3a 17/30 and S2 5/24 — hundreds
of assertions failing at once, in code none of them touched.
**Cause:** S3c needs fixtures naming task ids that do not exist until it creates
them, so it recreated the API container with its own
`JARVIS_FAKE_MODEL_SCRIPT`. The override stuck. Every suite that ran afterwards
was answered from S3c's three-entry fixture.
**Fix:** the fake model reads an optional overlay from
`JARVIS_ROOT/fake-overlay.json` on the shared volume, merged in front of the
base script. No restart, no env change, and `dev-seed` deletes it so a crashed
run heals itself.
**Lesson:** a test that mutates shared infrastructure has to restore it, and
"restore it in a trap" is weaker than "never mutate it". Prefer a mechanism the
seed can undo.

### A bind mount left a directory where the test expected a file
**Symptom:** the S3c fixture silently failed to write, so the router had no
scripted verdict and sixteen assertions failed as though routing were broken.
**Cause:** an earlier attempt mounted the fixture with `-v "$FIX:/in.json"`.
Docker creates a *directory* at a source path that does not exist, so
`/tmp/s3c-fixture.json` became a directory and stayed one. Every later
`json.dump(open(out,"w"))` failed, and without `set -e` the script carried on.
**Fix:** a per-run path, `rm -rf` before writing, and an explicit
`[ -s "$FIX" ] || exit 1` guard so an unwritten fixture aborts loudly.
**Lesson:** Docker bind mounts create missing sources as directories. And a test
that builds its own fixture must assert the fixture exists before trusting a
single result that depends on it.

### The build-fails-silently trap, a third time — and the fix
**Symptom:** three separate see-it-fail passes reported confident greens for
sabotaged code, because the sabotage did not typecheck, the Docker build failed,
and the previous image kept serving.
**Cause:** `docker compose up --build` prints its error inside a long build log,
and the command was piped through `tail`.
**Fix:** `scripts/dev-rebuild.sh` typechecks on the host first, builds with the
log captured, greps it for `error TS` / `#N ERROR` even on exit 0, and exits
non-zero on any of them — so `dev-rebuild.sh && run-suite` cannot run a suite
against a stale image. It caught the very next sabotage attempt.
**Lesson:** when the same mistake happens three times, stop writing it down and
make it impossible. A note is a reminder; a guard is a fix.

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

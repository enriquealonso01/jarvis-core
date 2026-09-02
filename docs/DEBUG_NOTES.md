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

### `RETURNING` gave back the value it had just written
**Symptom:** S20's endpointing worked — the utterance accumulated, the timer
fired — and then Jarvis said nothing at all. The row showed `pending_text` gone,
so the turn had plainly been claimed, and `takeTurn` reported "nothing was said".
**Cause:** `UPDATE calls SET pending_text = NULL ... RETURNING pending_text`
returns the NEW value. It cleared the caller's words and handed back the NULL it
had just written, so the claim succeeded and the claimant was told there was
nothing there.
**Fix:** read the old value from a locked subquery —
`FROM (SELECT pending_text FROM calls WHERE ... FOR UPDATE) old ... RETURNING
old.pending_text` — which still lets exactly one claimant win.
**Lesson:** `RETURNING` is not "what was there". For a claim-and-clear it has to
be told explicitly where to look, or the operation silently becomes a delete.

### The "are you still there?" prompt swallowed the caller mid-sentence
**Symptom:** with the in-process timer gone (the restart case), the worker sweep
saw a call waiting for the caller to finish and asked "Are you still there, sir?"
instead of answering them.
**Cause:** the sweep tested `state === "listening"` before it tested
`leg === "endpoint"`. A caller pausing mid-sentence is also `listening` — the
silence branch caught them first.
**Lesson:** two branches keyed on different columns of the same row are ordered
by whichever is more specific, not by whichever was written first. The specific
one is the deadline's own leg; the state is the fallback.

### The runaway loop came back as a one-word kindness
**Symptom:** S19's first run: three transcription segments of one sentence
produced three spoken replies, and a second process sent mid-call was answered
rather than refused. Both regressions the step exists to prevent, on the same
run that introduced the state machine meant to prevent them.
**Cause:** the persisted gate was written as `move(..., "thinking", { from:
["listening", "speaking"] })`. Allowing `speaking` looked like politeness — let
the caller interrupt — and it is exactly the runaway loop: while a reply is
playing, every further segment is admitted and answered.
**Fix:** `from: ["listening"]`, one state wide. Barge-in is S20 and needs the
playback actually stopped, not the gate widened.
**Lesson:** the regression tests were written before the feature, exactly as the
plan orders, and they caught the feature reintroducing the bug within an hour of
it being written. Had they been written afterwards they would have been written
to match the code, and the code was wrong.

### A faked provider hid what was actually said
**Symptom:** "and what it says is that it is still working" failed while the
call plainly said it — the assertion could see only a URL.
**Cause:** with TTS working, a line goes out as `playback_start` with an
`audio_url`; only the fallback path carries the words in `speak`'s `payload`.
Asserting on the command body therefore tested the failure path and nothing
else.
**Fix:** `spokenLines` records every line handed to the voice, whichever voice
speaks it.
**Lesson:** when a fake stands in for a provider, assert on the thing that
crossed the boundary, not on the shape the boundary happened to take that day.

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

### The recovery ladder parked tasks and never came back for them
**Symptom:** S4's drain test, run while verifying S19, left its task in
`recovering` forever. Three minutes of waiting did not move it.
**Cause:** the watchdog only looks at tasks in `running` or `preparing` — which
was right when recovery was one action (requeue, and the task is running again
next tick). Rung 1 of the S18b ladder is `wait`, which leaves the task in
`recovering` **on purpose**. Nothing ever looked at it again, so every stalled
task waited thirty seconds and then waited forever.
**Fix:** `climbParked()` in the worker: any task in `recovering` whose last
recovery event is older than that rung's backoff climbs again.
**Lesson:** the ladder's own test called `climb()` in a loop, so it proved the
ladder climbs when something calls it — and never asked whether anything in
production calls it twice. A unit test that supplies the caller cannot discover
that there is no caller. The suite that caught this drives the real watchdog.

### A backoff is a lease, so the runner has to outlive it
**Symptom:** after the fix above, the requeue worked and the second runner still
found nothing: the task sat `queued` and the runner exited.
**Cause:** `requeue()` implements a rung's cooling-off period by setting
`lease_until = now() + backoff`, which the claim query already respects. Rung 3
waits 15s; the test's runner gave up after `RUNNER_IDLE_EXIT_MS=8000`.
**Fix:** the S4 runners idle for 40s, longer than any rung's backoff.
**Lesson:** when a delay is expressed as data another query already honours,
nothing announces it. Everything downstream that has its own patience has to be
told about it.

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

### Assertions inside `$( )` are decoration: the subshell throws the count away
**Symptom:** the S11 suite reported 17 passed, 0 failed. Sabotaging the failure
classifier turned only 4 of them red — far fewer than the change should have
broken.
**Cause:** three of the five failure cases were invoked as
`T1=$(one_failure ...)`. A command substitution runs in a **subshell**, so every
`check()` inside it incremented a copy of `pass`/`fail` that was discarded when
the subshell exited, and the PASS/FAIL lines were swallowed by the `| tail -1`
used to read the task id back. Those cases could have failed silently forever.
**Fix:** the helper writes the task id to a variable instead of stdout, and is
never called inside a capture. With that, the same sabotage turns **10** red.
**Lesson:** in shell, a function that both asserts and returns a value cannot do
both through stdout. If a suite's failure count does not move when you break the
thing it tests, suspect the harness before the code.

### Retryable failures leave tasks queued, and the next test claims them
**Symptom:** after S11 made several failure classes retryable, S1 went from 23/23
to 6/17 — with empty `error_class` values, as if the runner had not run.
**Cause:** it had not. A retryable failure requeues its task, so the next
variant's one-shot runner claimed the PREVIOUS variant's leftover instead of the
new one. Both suites were written when every failure was terminal and nothing
stayed on the queue.
**Fix:** both suites cancel any queued heavy task before creating theirs, so each
case is the only thing a one-shot runner can claim.
**Lesson:** a test that creates work in a shared queue is only isolated while
nothing else survives. Changing retry behaviour silently changed what every
later test was actually running.

### A containment tripwire that destroyed two correct runs
**Symptom:** two live engineering runs were killed and recorded as
`security.isolation` breaches. Neither was one. The first "reached outside its
worktree" by touching `/var/lib/jarvis/projects/<slug>/repo` — its own
repository, which a git worktree necessarily references. The second was flagged
for the literal string `/var/lib/jarvis` appearing in a shell command.
**Cause:** when the harness gained the ability to execute commands (S6), the
escape guard was widened to scan Bash command text for absolute paths under
JARVIS_ROOT. Scanning free text for paths is far too blunt: two false positives,
zero true positives, and each one threw away a completed piece of work.
**Fix:** the worktree's own project directory is allowed, and the command scan
now flags only what would actually be a breach — another project's directory, or
the keys and harness-auth directories. Real containment is the per-project unix
user (ADR 006 step 5, proved in S12); this is a tripwire, not a wall.
**Lesson:** a containment check with a high false-positive rate does not protect
anything. It destroys correct work and teaches whoever maintains it to switch it
off, which leaves you with neither the check nor the belief that you needed one.

### A vague report is not the same as an unreproducible one
**Symptom:** S6's live "unreproducible" case failed: the harness reproduced
something, fixed it, and opened a second pull request.
**Cause:** the test asked about "odd output" in a repository that still contained
the real trailing-dash bug on main, because the first run's fix was in an
unmerged PR. The report was vague, but the repository genuinely was broken — so
the harness was right to find something. A correct run against a badly chosen
premise.
**Fix:** the report now describes something that cannot happen — "slugify()
occasionally returns undefined" when the function always returns a string. The
run then stopped at the reproduce phase and opened nothing.
**Lesson:** to test "it says it cannot reproduce", the thing must actually be
impossible to reproduce. Vagueness is not enough, and a test that punishes a
model for correctly finding a real bug is testing the wrong property.

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

### The shell rewrote the path, and the suite blamed the product
**Symptom:** S12's cross-project probe reported that the runner did not notice a
task reading another project's `.env` — the exact hole the step exists to close.
Separately, S9 went from 18/18 to 10/8 with "no reviewer route answered" on
every case, and S3b/S3c/S4 fell over with them.
**Cause:** Git Bash on Windows rewrites anything shaped like a unix path in an
argument. `-e JARVIS_PROBE_PATH=/var/lib/jarvis/projects/beta/repo/.env` arrived
in the container as `C:/Program Files/Git/var/lib/jarvis/...`, so the probe asked
for a path that does not exist and the guard correctly ignored it. The same
rewrite turned `-e JARVIS_FAKE_MODEL_SCRIPT=/app/scripts/fixtures/...` into a
path with no file behind it, `readScript` swallowed the ENOENT and returned
empty arrays, and the fake reviewer — which fails closed by design — answered
with nothing.
**Fix:** every suite exports `MSYS2_ARG_CONV_EXCL='*'` and `MSYS_NO_PATHCONV=1`
before it starts, and so does `scripts/sweep.sh`.
**Lesson:** two hours went into "why is the escape guard broken" and "why did S9
regress" for a bug that was in neither. When a suite's result changes with the
shell that started it, suspect the shell before the code — and then make the
suite independent of it, because the next person will not remember.

### Assertions counted against the whole database, not against the run
**Symptom:** after a day of runs, six assertions across S2, S3, S3b, S3c and S4
went red on a green codebase: "one event, not three — actual 4", "task_create
audited once per created task — expected 4, actual 14", "an issue was raised for
the stall — actual 4", and a status query that returned
`resolved\nresolved\nresolved\nresolved` and compared unequal to `resolved`.
**Cause:** they were written as absolute counts — `count(*) FROM task_context`,
`WHERE raw_text LIKE 'Quick brain dump%'`, `WHERE dedupe_key =
'worker.crash:heavy'` — which are only correct on the first run after a seed.
Every later run counted its own rows plus every earlier run's.
**Fix:** count a delta (capture before, assert before+1) or scope to this run —
`created_at >= $RUN_START`, `ORDER BY created_at DESC LIMIT 1`, or the id the
test itself created. One assertion changed meaning rather than scope: "two
threads were opened from this event" now counts `DISTINCT conversation_id` on
the tasks, because reusing an existing project thread is correct behaviour and
the old query called it zero threads.
**Lesson:** an assertion that only holds on a freshly seeded database is a
landmine with a delay fuse. It passes when written, and months later reports a
product failure that never happened — which is worse than failing, because
somebody will go looking for the bug.

### Every live update the runner sent went into an empty room
**Symptom:** S14's first run: the console showed nothing at all while a real S6
run was executing. The database ended with 11 phase events and 11 tool events;
the page, never reloaded, showed zero. The paused banner never appeared either.
**Cause:** `sseBroadcast` writes to a `Set` of connected replies held **in the
calling process**. The browsers connect to the API. The runner and the worker are
different processes — different containers in dev, a systemd unit beside a
container in production — so every broadcast either of them made was written into
an empty set and dropped. This had been true since S1. It looked like it worked
because opening the page fetches current state, and current state is usually
recent, so the only thing that was ever actually live was what the API itself did
to a task.
**Fix:** broadcasts leave the process over Postgres `LISTEN`/`NOTIFY`
(`startSseBridge`). The API listens and relays to its own clients; the runner and
worker forward and never listen, so a notification cannot loop. A dedicated
client, not a pooled connection — `LISTEN` belongs to a session, and a pooled
connection is handed back the moment the query returns, taking the subscription
with it.
**Lesson:** an in-process pub/sub in a multi-process system is a no-op with a
convincing API. Nothing errors, nothing warns, and the feature is only missing
when someone watches for a change they did not cause themselves.

### A CHECK constraint turned the recovery ladder into the loop it forbids
**Symptom:** the ladder climbed rung 1 twelve times in a row and never reached
rung 2. Every assertion about escalation failed, and the task sat in `recovering`
forever.
**Cause:** the ladder records each rung as a `task_events` row of type
`recovery`, and `task_events.type` had a CHECK constraint allowing six kinds —
not that one. Every insert was rejected. The insert is deliberately wrapped in a
`.catch()`, because a timeline write must never break a recovery, so the
rejection was silent; the ladder then read back "nothing has been tried" on every
pass and did the cheapest rung again. II.3's own warning describes the result
exactly: "a ladder without limits is exactly how an infinite retry loop is
built" — except the limits were there and the memory of using them was not.
**Fix:** migration 019 adds `recovery` to the allowed types.
**Lesson:** a swallowed write plus a decision that reads that write back is a
loop waiting to happen. When a catch is genuinely right — and it was — the thing
that reads the data has to be able to tell "nothing happened" from "nothing was
recorded", or add a test that asserts the row exists rather than the behaviour it
should have produced.

### A line in an activity feed took down a state transition
**Symptom:** S3c went from 22/22 to 9/22 after S18 added an activity feed.
Symptoms in the database: a task that had genuinely been `running` ended
`queued` with **zero attempts**, no delivered context and no checkpoint — a
finished run that looked abandoned.
**Cause:** `transitionTask` gained a feed write for the interesting states, and
the metadata query plus the `await import("./search.js")` sat OUTSIDE any catch.
`search.ts` pulls the whole route surface and `requireUser` with it; importing
that inside the runner threw, the exception propagated out of `transitionTask`,
and the runner's completion path died half-way — after the state change and
before everything that follows it.
**Fix:** two things, and both were needed. The feed write is wrapped whole, so
nothing in it can fail a transition. And the writers moved to `src/activity.ts`,
a leaf module with no route imports, so a hot path never drags the API surface
into the runner for the sake of one INSERT.
**Lesson:** anything added to a path as central as a state transition has to be
unable to throw, and a dynamic import in that path imports everything the target
module imports. Observability that can break the thing it observes is worse than
no observability.

### A script edited and run in the same command runs the version bash already read
**Symptom:** twice — adding s16 and then s18 to `scripts/sweep.sh` and running the
sweep in the same shell command produced a table with every suite EXCEPT the one
just added. The file on disk plainly contained it.
**Cause:** bash reads a script lazily, by byte offset, and the sweep was launched
from a compound command that had already been parsed. Editing the file underneath
a shell that is partway through it is undefined behaviour, and here it silently
ran the older text.
**Fix:** edit, then run in a SEPARATE command. Both times the second run was
correct with no other change.
**Lesson:** "the file says so" is not evidence that the process running it saw
that. Anything that edits a script and then executes it needs the execution to be
a new invocation, or the result is about a version that no longer exists.

### The keyboard test pressed Enter on whatever it found, and cancelled the task
**Symptom:** L17's keyboard half started failing at "the health strip opens with
Enter", and then the next three journeys failed too — the task they used had
become `cancelled` halfway through the run.
**Cause:** the walk was `await tabTo(page, target); await keyboard.press("Enter")`
— the press was unconditional. When `tabTo` could not find its target it returned
null and the Enter went to whatever happened to hold focus, which on the work
page is a row of buttons ending in **Cancel**. The test was cancelling the task
it was about to assert on, and every failure after that was about a task that no
longer existed.
**Fix:** Enter is only pressed on a control the walk actually found; a miss is an
assertion failure and nothing else. And the walk targets the real focusable
element — the `<summary>`, not a `<span>` inside it, which is not focusable and
never matched.
**Lesson:** a test that acts when it cannot find its target does damage rather
than reporting a problem, and the damage then looks like a different bug. Every
synthetic key press or click needs a found-it guard, especially in a UI with
destructive controls.

### An unreachable API signed you out of a console you were signed in to
**Symptom:** with the API unreachable, every page in the console redirected to
the login screen. S15's "does every screen name the state" pass reported no state
on all fifteen routes, because none of them was still on screen to report one.
**Cause:** every page began `const me = await api("/api/me"); if (!me.ok)
window.location.href = "/login/"`. A network failure is not-ok, so an outage was
indistinguishable from an expired session — and the console then told Enrique the
one thing that was definitely false.
**Fix:** redirect only on 401 or 403. Everything else is reported by the shell's
connection banner, which says whether the request failed to arrive, came back an
error, or is simply old.
**Lesson:** `!res.ok` collapses "the server refused you" and "there is no server"
into one branch, and the two need opposite responses. Wherever a failure decides
what to tell the user, the status code has to be looked at, not the boolean.

### The test harness served the console from a different origin, and the CSRF guard did its job
**Symptom:** three of L17's six journeys failed — adding context to a running
task, approving something, and anything else that POSTs. The endpoints existed,
the buttons were there, the clicks happened, and nothing changed in the database.
It read as three separate broken features.
**Cause:** `originOk` compares the browser's `Origin` against `JARVIS_ORIGIN`. In
production Caddy serves the console and the API from one origin so they match.
The test harness serves the export on its own port, so every guarded endpoint
answered 403 — correctly.
**Fix:** `console-serve.mjs` rewrites `Origin` (and `Referer`) to the configured
API origin when proxying. That reproduces production rather than disabling the
check: the guard still runs, against exactly the value it would see in
production.
**Lesson:** a harness that is *almost* the production shape fails in the places
where the difference lives, and those failures look like product bugs in whatever
feature happened to be tested first. When several unrelated features fail the
same way, suspect the thing they have in common.

### A failed build left the last good one in place, and the sabotage passed
**Symptom:** S15's state suite was sabotaged — every state made to fall through
to a blank panel, which is the exact failure the step exists to prevent — and it
reported **10 passed, 0 failed**.
**Cause:** `next build` compiles first and type-checks second. The sabotage broke
type narrowing, the type-check failed, and `out/` was left holding the previous
export. The suite then measured the last good build. `pnpm build` had been run
with its output redirected to /dev/null, so the failure was invisible.
**Fix:** `scripts/console-rebuild.sh`, which fails loudly on a build error and
additionally refuses to continue if `out/index.html` is older than the newest
source file. Every console suite goes through it.
**Lesson:** this is the third time a stale artifact has reported green — twice
with Docker images, now with a static export — and the shape is always the same:
a build step whose failure is silent, followed by a test that reads the output
directory. Never redirect a build's output away, and have the test refuse to run
on an artifact older than its sources. The first two cost hours; this one was
caught only because the sabotage was supposed to fail and did not.

### One open connection stopped every one-shot runner from exiting
**Symptom:** the sweep produced no output for twenty-five minutes. `docker ps`
showed twelve `jarvis-dev-runner-run-*` containers still up, the oldest
thirty-five minutes old, all of them one-shot runners that had finished their
task. Every suite that waits for `docker compose run` to return was hanging on
the first one.
**Cause:** the SSE bridge opens a `pg.Client`, and a live client's socket is an
active libuv handle. `RUNNER_ONCE` claimed its task, ran it, returned from
`main()` — and then the process had nothing left to do and no reason to exit.
The work all succeeded, which is why nothing looked wrong except the clock.
**Fix:** `unref()` the bridge sockets. The connection stays usable; it just stops
being a reason for the process to live.
**Lesson:** adding a long-lived connection to a process that is supposed to end
changes when it ends. The symptom is not an error — it is a process that has
finished and stays.

### The offline switch does not apply to localhost
**Symptom:** S14 has to kill the connection mid-run and see "Live updates
paused". `context.setOffline(true)` produced no banner for fifteen seconds, so
the test reported the banner as missing — a feature that was working.
**Cause:** Chromium's network emulation does not cover loopback, and the whole
dev stack is on 127.0.0.1. The EventSource stayed happily connected.
**Fix:** kill the static server the page is talking to, and restart it. The API
and the runner are untouched, so the run keeps going and the events produced
during the outage are exactly the ones the catch-up has to recover.
**Lesson:** when a test says a feature is missing, check that the test's way of
provoking it actually provokes it. This one would have had me delete working code
and write it again.

### A test left one row behind, and the seed died half-done
**Symptom:** every suite that talks to the console failed at once with an empty
conversation id and a 500 from the API. The stack looked broken.
**Cause:** `dev-seed` truncates the work tables and then deletes non-fixture
projects. S12 had allowlisted an auth profile to a temporary project, and
`auth_profile_allowlists` has a plain foreign key with no `ON DELETE` rule, so
the delete raised and the seed exited **after** the truncate. The database was
left with no console thread at all.
**Fix:** the seed removes the rows that point at a project (`auth_profile_
allowlists`, `connection_project_allowlist`, `connections`) before deleting it.
**Lesson:** a reset that is not atomic must do its destructive half last, or it
turns one test's leftovers into a broken stack for every test after it. The
seed's own comment already said "one test silently changes the world the next
one runs in" — it was right, and it was about itself.

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

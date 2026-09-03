# Debug notes

Bugs that cost real time. Each one is here so it is found in minutes next time
instead of hours.

**The rule** (Master Plan III.0 §6): when something breaks twice for the same
reason, or once expensively, it gets an entry here **and** a regression test
before the fix is committed. An entry without a test is a note; an entry with a
test is a fix that stays fixed.

Format: symptom → cause → fix → the general lesson.

## Index

This file is long enough that "read it before you write" is not an instruction
anyone follows. **Read the section for the area you are about to touch** — that
is two or three entries, and it is where the time is actually saved.

**Backups and deploys**
- [A code deploy silently reverted files that were not code](#a-code-deploy-silently-reverted-files-that-were-not-code)
- [`plugins install` reported success while installing nothing](#plugins-install-reported-success-while-installing-nothing)
- [An OpenClaw plugin http handler must write its own response](#an-openclaw-plugin-http-handler-must-write-its-own-response)
- [Configuring the WhatsApp channel needs a newer runtime and a non-interactive approval](#configuring-the-whatsapp-channel-needs-a-newer-runtime-and-a-non-interactive-approval)
- [Jarvis rejected its own outbound calls, and the calls worked anyway](#jarvis-rejected-its-own-outbound-calls-and-the-calls-worked-anyway)

**Phone**
- [A CRITICAL isolation alert for an `ls`](#a-critical-isolation-alert-for-an-ls)
- [A pleasantry became a heavy task, twice over](#a-pleasantry-became-a-heavy-task-twice-over)
- [The sweep stopped at s25, so a runner change broke a suite unseen](#the-sweep-stopped-at-s25-so-a-runner-change-broke-a-suite-unseen)
- [A new column broke three call suites, silently](#a-new-column-broke-three-call-suites-silently)
- [Jarvis transcribed its own greeting as if the caller had said it](#jarvis-transcribed-its-own-greeting-as-if-the-caller-had-said-it)
- [One utterance produced several replies, and the call ran away](#one-utterance-produced-several-replies-and-the-call-ran-away)
- [A python edit that asserted its anchors, failed, and left nothing behind](#a-python-edit-that-asserted-its-anchors-failed-and-left-nothing-behind)
- [An assertion that could not fail because the code guarded twice](#an-assertion-that-could-not-fail-because-the-code-guarded-twice)
- [A suite left live Level 3 approvals, and the next suite clicked one](#a-suite-left-live-level-3-approvals-and-the-next-suite-clicked-one)
- [The scrubber redacted the search term, and the test reported a leak](#the-scrubber-redacted-the-search-term-and-the-test-reported-a-leak)
- [`RETURNING` gave back the value it had just written](#returning-gave-back-the-value-it-had-just-written)
- [The "are you still there?" prompt swallowed the caller mid-sentence](#the-are-you-still-there-prompt-swallowed-the-caller-mid-sentence)
- [The runaway loop came back as a one-word kindness](#the-runaway-loop-came-back-as-a-one-word-kindness)
- [A faked provider hid what was actually said](#a-faked-provider-hid-what-was-actually-said)

**Workers and the queue**
- [The heavy lane never ran anything, for the entire life of v1](#the-heavy-lane-never-ran-anything-for-the-entire-life-of-v1)
- [The recovery ladder parked tasks and never came back for them](#the-recovery-ladder-parked-tasks-and-never-came-back-for-them)
- [A backoff is a lease, so the runner has to outlive it](#a-backoff-is-a-lease-so-the-runner-has-to-outlive-it)
- [Task claiming silently broke and the suite stayed green](#task-claiming-silently-broke-and-the-suite-stayed-green)
- [Watchdog tickets were opened and never closed](#watchdog-tickets-were-opened-and-never-closed)

**Credentials and routing**
- [The `to_e164` in `site.yaml` is not the number the outbound dial uses](#the-to_e164-in-siteyaml-is-not-the-number-the-outbound-dial-uses)
- [The outbound sweep never looks at a `wanted` row](#the-outbound-sweep-never-looks-at-a-wanted-row)
- [A delivered call is not a ringing phone](#a-delivered-call-is-not-a-ringing-phone)
- [One sweep dialled twice, and the carrier stopped the second one](#one-sweep-dialled-twice-and-the-carrier-stopped-the-second-one)
- [Every model route failed and the reason was unknowable](#every-model-route-failed-and-the-reason-was-unknowable)
- [Host logins were completed and Jarvis kept asking for them](#host-logins-were-completed-and-jarvis-kept-asking-for-them)

**Backups and deploys**
- [`deploy-control-center.sh` republished a stale build, silently](#deploy-control-centersh-republished-a-stale-build-silently)
- [There are two `/opt/jarvis` trees and only one of them is the build context](#there-are-two-optjarvis-trees-and-only-one-of-them-is-the-build-context)
- [The console has been reporting a build state from a file nobody updates](#the-console-has-been-reporting-a-build-state-from-a-file-nobody-updates)
- [The em-dashes were never mis-encoded; the header was missing](#the-em-dashes-were-never-mis-encoded-the-header-was-missing)
- [GitHub acknowledged the commit and then served the old file](#github-acknowledged-the-commit-and-then-served-the-old-file)
- [The Supervisor read project instructions from a key nothing writes](#the-supervisor-read-project-instructions-from-a-key-nothing-writes)
- [The canonical row and the committed file differed by one newline](#the-canonical-row-and-the-committed-file-differed-by-one-newline)
- [Two writers bypassed the versioning path, and every test stayed green](#two-writers-bypassed-the-versioning-path-and-every-test-stayed-green)
- [`pnpm build` on the host half-succeeded for days, and nobody noticed](#pnpm-build-on-the-host-half-succeeded-for-days-and-nobody-noticed)
- [Three hours of work was committed to `main` because a heredoc had an apostrophe](#three-hours-of-work-was-committed-to-main-because-a-heredoc-had-an-apostrophe)
- [The backups did not contain the database](#the-backups-did-not-contain-the-database)
- [Deploying the console 404'd the whole site](#deploying-the-console-404d-the-whole-site)
- [The dev harness profile evaporated the first time the worker ran](#the-dev-harness-profile-evaporated-the-first-time-the-worker-ran)
- [Assertions inside `$( )` are decoration: the subshell throws the count away](#assertions-inside---are-decoration-the-subshell-throws-the-count-away)
- [Retryable failures leave tasks queued, and the next test claims them](#retryable-failures-leave-tasks-queued-and-the-next-test-claims-them)
- [A containment tripwire that destroyed two correct runs](#a-containment-tripwire-that-destroyed-two-correct-runs)
- [A vague report is not the same as an unreproducible one](#a-vague-report-is-not-the-same-as-an-unreproducible-one)
- [The Supervisor answered the wrong message when two arrived at once](#the-supervisor-answered-the-wrong-message-when-two-arrived-at-once)
- [A fixture that lied about being GitHub-linked parked every successful run](#a-fixture-that-lied-about-being-github-linked-parked-every-successful-run)
- [`info/exclude` lives in the COMMON dir, and the first real run proved it](#infoexclude-lives-in-the-common-dir-and-the-first-real-run-proved-it)
- [The harness could edit but not execute, so its loop could never finish](#the-harness-could-edit-but-not-execute-so-its-loop-could-never-finish)
- [A worktree's `.git` is a file, so the exclude was never written](#a-worktrees-git-is-a-file-so-the-exclude-was-never-written)
- [Phases were recorded only on the success path, so crashes lost them](#phases-were-recorded-only-on-the-success-path-so-crashes-lost-them)
- [A two-phase key test regenerated the keys between the phases](#a-two-phase-key-test-regenerated-the-keys-between-the-phases)
- [A restart threw away the run it was supposed to preserve](#a-restart-threw-away-the-run-it-was-supposed-to-preserve)
- [`kill -TERM -1` does not signal PID 1, so the repro missed the bug](#kill--term--1-does-not-signal-pid-1-so-the-repro-missed-the-bug)
- [A failed harness run was recorded with a blank summary](#a-failed-harness-run-was-recorded-with-a-blank-summary)
- [The runner had no memory ceiling](#the-runner-had-no-memory-ceiling)

**Test environment**
- [Deleting a test project needs eight tables and one circular link](#deleting-a-test-project-needs-eight-tables-and-one-circular-link)
- [A suite failed on the consequence of its own second case](#a-suite-failed-on-the-consequence-of-its-own-second-case)
- [The API could not start anywhere except the box](#the-api-could-not-start-anywhere-except-the-box)
- [A test changed the API container's environment and every later suite lied](#a-test-changed-the-api-containers-environment-and-every-later-suite-lied)
- [A bind mount left a directory where the test expected a file](#a-bind-mount-left-a-directory-where-the-test-expected-a-file)
- [The build-fails-silently trap, a third time — and the fix](#the-build-fails-silently-trap-a-third-time--and-the-fix)
- [The seed did not reset what a test had created, so tests changed each other](#the-seed-did-not-reset-what-a-test-had-created-so-tests-changed-each-other)
- [A fixture keyed on a phrase swallowed every longer message containing it](#a-fixture-keyed-on-a-phrase-swallowed-every-longer-message-containing-it)
- [TRUNCATE CASCADE quietly deleted every conversation](#truncate-cascade-quietly-deleted-every-conversation)
- [The sabotage did not compile, so the build failed and the old image kept running](#the-sabotage-did-not-compile-so-the-build-failed-and-the-old-image-kept-running)
- [A whole test run went red on a UUID that was perfectly valid](#a-whole-test-run-went-red-on-a-uuid-that-was-perfectly-valid)
- [A deliberate sabotage silently did nothing, and the test "passed"](#a-deliberate-sabotage-silently-did-nothing-and-the-test-passed)
- [The shell rewrote the path, and the suite blamed the product](#the-shell-rewrote-the-path-and-the-suite-blamed-the-product)
- [Assertions counted against the whole database, not against the run](#assertions-counted-against-the-whole-database-not-against-the-run)
- [Every live update the runner sent went into an empty room](#every-live-update-the-runner-sent-went-into-an-empty-room)
- [A CHECK constraint turned the recovery ladder into the loop it forbids](#a-check-constraint-turned-the-recovery-ladder-into-the-loop-it-forbids)
- [A line in an activity feed took down a state transition](#a-line-in-an-activity-feed-took-down-a-state-transition)
- [A script edited and run in the same command runs the version bash already read](#a-script-edited-and-run-in-the-same-command-runs-the-version-bash-already-read)
- [The keyboard test pressed Enter on whatever it found, and cancelled the task](#the-keyboard-test-pressed-enter-on-whatever-it-found-and-cancelled-the-task)
- [An unreachable API signed you out of a console you were signed in to](#an-unreachable-api-signed-you-out-of-a-console-you-were-signed-in-to)
- [The test harness served the console from a different origin, and the CSRF guard did its job](#the-test-harness-served-the-console-from-a-different-origin-and-the-csrf-guard-did-its-job)
- [A failed build left the last good one in place, and the sabotage passed](#a-failed-build-left-the-last-good-one-in-place-and-the-sabotage-passed)
- [One open connection stopped every one-shot runner from exiting](#one-open-connection-stopped-every-one-shot-runner-from-exiting)
- [The offline switch does not apply to localhost](#the-offline-switch-does-not-apply-to-localhost)
- [A test left one row behind, and the seed died half-done](#a-test-left-one-row-behind-and-the-seed-died-half-done)
- [`pnpm build` on the host half-succeeded for days, and nobody noticed](#pnpm-build-on-the-host-half-succeeded-for-days-and-nobody-noticed)

**Process**
- [Thirty-one overnight ticks produced no progress on the thing that mattered](#thirty-one-overnight-ticks-produced-no-progress-on-the-thing-that-mattered)
- [Five defects reached him at once, all above the layer the tests covered](#five-defects-reached-him-at-once-all-above-the-layer-the-tests-covered)
- [A CHECK constraint rejected every verdict and nothing said so](#a-check-constraint-rejected-every-verdict-and-nothing-said-so)
- [Three probes lied because MSYS rewrote the path](#three-probes-lied-because-msys-rewrote-the-path)
- [A stray container claimed every task and looked like a regression](#a-stray-container-claimed-every-task-and-looked-like-a-regression)


---

## Phone

### A pleasantry became a heavy task, twice over
**Symptom:** a task titled `Hello, can you finish what you were saying?` in the
heavy lane, with no project.
**Not the router.** The router got this right - it classified the sentence
`question` and filed nothing. The task came from the phone HANDOVER, which
called `createTask` with `projectId: null` unconditionally whenever the phone
budget expired and the router had filed nothing. So any turn the desk was slow
to answer produced heavy work titled with the raw utterance, whether or not
there was anything to do.
**Fix:** `handoverTaskFor` - no project, no task. Heavy work needs a repository;
without one there is nothing to check out and nothing to read, and the desk
answers into the thread regardless, task or no task. A scoped conversation still
files its task and it carries the project.
**Where to look next time:** the routing verdict is stored on the inbox event
(`route_category`, `route_segments`), so "what did the router think" is one
query and does not need guessing. It said `question`. Believing the title of the
task instead would have sent the fix into the classifier, which was not wrong.
### A new column broke three call suites, silently
**Symptom:** `s21-runtime`, `s21b-call-defects` and `s24-callreview` each failed
on unrelated-looking assertions - a turn `open` instead of `answered`, no answer
text, no total_ms.
**Cause:** mine. Migration 035 added `call_turns.answered_by` and I applied it to
production but not to the dev database. `finishTurn` builds its UPDATE from the
field names it is given, so every call included `answered_by = $n`, every UPDATE
threw, and `finishTurn` swallows the error with a `console.error`. The turn was
simply never closed. All three failing assertions were fields written by that one
statement.
**Fix:** apply the migration in dev too. Applying it turned 3 failing suites into
43, 35 and 34 passed with no code change.
**The wider lesson:** a schema change is not deployed until every database that
runs the code has it, and dev is one of those. The swallow is what made it quiet:
`could not close the turn` went to stderr while the suite reported a behavioural
failure three layers away.

### The sweep stopped at s25, so a runner change broke a suite unseen
**Symptom:** `s28-park-test` failed 5 of 11 with assertions that made no sense -
the task parked in the right STATE while the reason had nothing to do with
runtimes.
**Cause:** mine. The heavy lane now refuses a task with no project, and that
guard runs before the runtime check. The suite creates its tasks with no
project, which was harmless when the runner would run anything, so every
assertion was reading the wrong park.
**Fix:** scope the fixture, not loosen the guard. A suite that depends on
unscoped heavy work being allowed is a suite asserting the old behaviour.
**The real finding:** `scripts/sweep.sh` is the regression net and its list
stopped at `s25-routing-test`. Everything from S26 onwards, and every suite
written since, was outside it - so a change to `runHeavyTask` could break an
existing suite and nothing would say so. Suites now go into the sweep when they
are written. The ones that CANNOT (live site, real money, real credentials) are
listed there with the reason, because a sweep that cannot pass is a sweep people
learn to ignore.
**Lesson:** writing a suite is half of it. A suite nothing runs is a comment.

### A CRITICAL isolation alert for an `ls`
**Symptom:** `[isolation] harness wrote outside the worktree`, critical, evidence
`attempted_path: /var/lib/jarvis/worktrees/unscoped`.
**What actually happened:** the task was the sentence "Hello, can you finish what
you were saying?" - conversational filler that became a heavy task with no
project. With no project there is no repository, so the run was given an empty
directory under `worktrees/unscoped`. Claude landed in it, correctly reported
there was nothing to continue from, and while looking around ran
`ls -la /var/lib/jarvis/worktrees/unscoped/`. That is outside the paths the run
may touch, so the tripwire killed the run and raised a critical - for a
directory listing, in an empty directory, on a task that should not have existed.
**Fix:** upstream, not in the tripwire, which was right: a run whose boundary is
an empty scratch directory has no meaningful boundary. The heavy lane now parks
a task with no project and quotes the sentence that caused it. Five of thirty
heavy tasks on the box had no project; none of 721 system tasks did.
**Also fixed:** the title said "wrote" when the tripwire cannot tell a read from
a write inside a Bash string, which sent the reader looking for a file that was
never created. It says "touched" now.
**Read the transcript first.** The ticket said to, and it answered the question
in one line: `fatal: not a git repository`.

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

### A python edit that asserted its anchors, failed, and left nothing behind
**Symptom:** S21's barge-in over an acknowledgement did not stop the playback,
and the call stayed in `thinking`. The code plainly said it should.
**Cause:** the edit that added `thinking` to the barge-in states was in a script
whose FIRST anchor assertion failed. The script exited before writing anything —
correctly — but three later edits in the same script went with it, and the rebuild
and the test run that followed looked like a code bug rather than an edit that
never happened.
**Fix:** re-applied them, and checked with `grep` that each landed rather than
trusting the script's exit.
**Lesson:** a batch edit that fails partway is a batch edit that did nothing.
Verify the file, not the script — and keep unrelated edits out of one batch.

### An assertion that could not fail because the code guarded twice
**Symptom:** deliberately removing the `clearTimeout` from barge-in did not turn
the "nothing queued behind it still gets spoken" assertion red.
**Cause:** the queued line was guarded twice — the timer was cleared AND the
callback checked a `cancelled` flag at fire time. Removing either one alone left
the other holding, so the test could not see the difference.
**Fix:** the sabotage removed both, which turned it red; both guards stay in the
code, since belt and braces is right here.
**Lesson:** "every test must have been seen to fail once" has to be checked
against the property, not against one line of code. A sabotage that a redundant
guard absorbs proves the guard, not the test.

### A suite left live Level 3 approvals, and the next suite clicked one
**Symptom:** S15's journeys failed on "the approval really changed state" the
moment the re-auth work landed. The endpoint worked when called directly, and
`deploy_staging` is not an always-confirm action, so the 403 made no sense.
**Cause:** the new re-auth suite seeds `secrets.export`, `db.destructive` and
`repo.delete` approvals and left some pending. S15's journey finds its row by
searching every element for text and clicking the first Approve button beneath
it — which was now one of those, and the server correctly demanded a password no
browser test was going to type.
**Fix:** the re-auth suite deletes its own always-confirm approvals at the end.
**Lesson:** a suite that leaves live rows behind is a suite that breaks the next
one, and the breakage lands somewhere unrelated. The browser test's crude
row-finder made it worse, but the leftover data is what changed.

### The scrubber redacted the search term, and the test reported a leak
**Symptom:** the canary test found the canary in `audit_events`, `messages` and
`notifications_outbox` — and the rows it printed plainly read
`[redacted:canary_...]`. It had found what it was looking for and what it was
looking for was not there.
**Cause:** the grep ran through the SAME pool the scrubber wraps, so
`%<canary>%` was scrubbed on its way into the query. It searched for
`%[redacted:canary_...]%`, which matches every row that was correctly redacted.
**Fix:** the grep opens its own unwrapped pool. A test of a filter cannot look
through the filter.
**Lesson:** when the thing under test sits on the path everything takes, the
test's own reads are on that path too. Ask what the assertion is going through
before believing what it says — this one failed in the direction that looks like
a security hole, which is the most expensive direction to be wrong in.

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

### A code deploy silently reverted files that were not code
**Symptom:** the build bar read "S28 of 40" while main said 51 steps. Separately,
and for two hours, a fixed OpenClaw plugin handler behaved exactly like the
broken one no matter how many times it was reinstalled.
**Cause:** one mechanism, two victims. Deploying is `git archive HEAD | tar -x`
into `/opt/jarvis/core`, so a deploy from any branch writes that branch's copy of
**every** file it touches. `PROGRESS.json` was served from that tree, so
deploying a feature branch reverted the plan state. The plugin's `package.json`
lived there too, and a deploy replaced it with main's copy, which lacks
`openclaw.extensions` - after which every `openclaw plugins install` failed with
`package.json missing openclaw.extensions` and left the previous build running.
**Fix:** state is served from `/var/lib/jarvis/state`, which no deploy writes;
`scripts/publish-progress.sh` publishes it from a ref.
**Lesson:** the deploy target is not a good home for anything that changes on a
different clock than the code. And the install output said exactly what was
wrong, both times, into a `>/dev/null` - suppressing the output of a step whose
success you are assuming is how two hours disappear.

### Jarvis rejected its own outbound calls, and the calls worked anyway
**Symptom:** an Issue, `[telnyx] rejected a call from an unrecognised number`,
five occurrences in a day, evidence `{"from": "+13057866217", "reason": "caller
is not the owner"}`. That number is Jarvis's own Telnyx number.
**Cause:** Telnyx sends `call.initiated` for outbound legs as well as inbound
ones, and the owner check ran on both. Every call Jarvis placed was measured
against "is the caller Enrique?", answered no - the caller is Jarvis - and was
sent a `reject`.
**Why nobody noticed:** the calls still connected. A later event arriving with no
call row invents one, so the conversation carried on and the rejection showed up
only as a ticket that looked like nuisance callers. A self-healing fallback hid a
real defect for a day.
**Fix:** `isOwnOutboundLeg` - the ccid matching a row we placed (authoritative,
from our own API response), Telnyx's own `direction`, or the from matching our
number for the race where the webhook beats the write. The last is
caller-controlled so it only ever WITHHOLDS: an outbound leg is neither answered
nor rejected, so a spoofer gets silence.
**Lesson two:** the test for "no spurious Issue" first passed under sabotage,
because `raiseIssue` dedupes - a repeat bumps `occurrences` instead of adding a
row. Count occurrences, not rows, or the assertion is blind to exactly the
repetition it is meant to catch.

### Configuring the WhatsApp channel needs a newer runtime and a non-interactive approval
**Symptom:** `channels add --channel whatsapp` failed with `requires plugin API
>=2026.8.2, but this OpenClaw runtime exposes 2026.8.1`; after upgrading it then
printed a capability box and stopped at `Setup cancelled.`
**Cause:** two separate gates. The channel plugin has a runtime floor, and its
capability approval is an interactive prompt that `channels add` has no flag for,
so it always answers No when stdin is not a terminal.
**Fix:** upgrade the image (`docker pull`, then `compose up -d openclaw`), then
`openclaw plugins install clawhub:@openclaw/whatsapp --accept-capabilities`
FIRST, and only then `channels add --channel whatsapp`, which now skips both.
**Also:** `session.dmScope` defaults to `main` when unset - one shared session
across every DM. Set it explicitly (`per-account-channel-peer`) before pairing,
or OpenClaw becomes the memory it is not supposed to be.
**Lesson:** an interactive prompt in a non-interactive context does not hang
here, it silently chooses the safe answer and reports success-shaped output.

### An OpenClaw plugin http handler must write its own response
**Symptom:** every request to the plugin route hung until the client timed out.
No error, no log line, and the handler was never entered.
**Cause:** the handler was written Fastify-style, returning `{ status, body }`.
The gateway calls `route.handler(req, res)` with raw Node objects and only
checks whether the result is `false`, meaning "not handled, try the next route".
Any other return value - including a perfectly formed response object - means
"handled", so the gateway stops and nothing is written to the socket. `req.body`
does not exist either; the body must be read off the stream, and it must be read
raw, before parsing, or an HMAC over re-serialised JSON will not match.
**Also:** `registerHttpRoute` requires `auth: "gateway" | "plugin"`. Omitting it
is a registration ERROR, logged once at startup and easy to miss.
**Lesson:** this was the fifth wrong plugin shape in this integration. Read the
signature out of the shipped bundle before writing against it - `grep` for the
call site, not the docs.

### `plugins install` reported success while installing nothing
**Symptom:** `plugins inspect` showed `Installed at:` an hour in the past after
three `--force` installs, so the gateway kept running old code.
**Fix:** never trust the install; compare the installed file with the source
(`grep -c` for a string only the new version has) before concluding anything
about behaviour.
**Lesson:** verify the artefact, not the command.


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

### `pnpm build` on the host half-succeeded for days, and nobody noticed
**Symptom:** deploying S24, `sudo -u jarvis pnpm build` in `/opt/jarvis/core`
printed a wall of `TS5033 ... EACCES: permission denied` — but only for files
that already existed. `dist/callreview.js` and `dist/retention.js`, both new,
were written fine, so a casual `ls` of the new modules looked like success.
**Cause:** 28 files in `dist/` were owned by `root` from an earlier build run as
root. `tsc` overwrites in place, so every module that had been compiled by root
before was unwritable by `jarvis` — and `tsc` reports those as errors and
carries on emitting the rest. The exit code is non-zero, but a pipeline that
ends in `| tail -3` shows the last three lines, which were the *new* files.
**Fix:** `chown -R jarvis:jarvis dist` and rebuild. `callcontrol.js`,
`worker.js` and `product.js` all changed size on the second run — meaning the
host runner had been executing stale compiled code for every one of those 28
modules since whenever that root build happened.
**Lesson:** this is the same fault Enrique reported against `/var/lib/jarvis/
projects/<slug>` — two identities (root in a container, `jarvis` on the host)
creating the same files. One owner per path, and check the exit code, not the
tail of the log. A build that partially fails is worse than one that fails.

---

### Three hours of work was committed to `main` because a heredoc had an apostrophe
**Symptom:** `git push -u origin step/s25-model-routing` answered `src refspec
step/s25-model-routing does not match any`. The branch did not exist. `git
branch --show-current` said `main`, and S25's entire commit was sitting on it.
**Cause:** the branch was created in the same compound command that wrote the
migration with a quoted heredoc, and that command never ran a single statement:
it died at parse time with ``unexpected EOF while looking for matching `'``. The
Bash tool wraps the whole command in single quotes, so an apostrophe inside the
heredoc body -- "the plan's own note" -- closes the wrapper. `<<'SQL'` protects
the content from the SHELL, not from the wrapper around it. The checkout was the
first statement in that command, so it never happened, and every later command
ran on `main`.
**Fix:** `git checkout -b <branch>` at the existing commit, then `git branch -f
main <the merge commit it should have stayed at>`. No reset, nothing discarded,
and nothing had reached the remote -- the push failing is what surfaced it.
**Lesson:** two of them. Write files with the editor rather than heredocs when
the prose contains apostrophes; and after `git checkout -b`, check
`git branch --show-current` before working, not at push time. A branch that was
never created looks exactly like a branch you are already on.

---

### `deploy-control-center.sh` republished a stale build, silently
**Symptom:** the console was redeployed and came back one version BEHIND — the
new page was missing and an older one was live.
**Cause:** the script takes a tarball of the **built static export** (`out/`) and
defaults to `/tmp/cc-out.tgz`. It was called with no argument after a tarball of
the SOURCE tree had been copied to the box, so it re-published whatever
`/tmp/cc-out.tgz` still held from the previous deploy. Its only sanity check is
that the tarball has `index.html` at its root, which a stale build passes.
**Fix:** `pnpm build` in `jarvis-control-center`, then `cd out && tar czf
/tmp/cc-out.tgz .`, scp it, then run the script **with that path**. It rsyncs
`--delete` into `/opt/jarvis/control-center`, which also means a source tree
untarred there beforehand is cleaned up.
**Lesson:** a publish step with a default input path will eventually publish the
default. Pass the argument every time.

### There are two `/opt/jarvis` trees and only one of them is the build context
**Symptom:** `docker compose up -d --build api worker` printed "Running" for
both, the containers were not recreated, and `dist/callreview.js` was absent
from the image after a deploy that reported success.
**Cause:** the compose file lives at `/opt/jarvis/deploy/compose.yaml` (which is
the project working dir) but its **build context is `/opt/jarvis/core`**. Code
extracted into `/opt/jarvis` changes nothing the image is built from. The host
runner (`jarvis-runner.service`, `User=jarvis`) also runs from
`/opt/jarvis/core/dist`, so that one tree feeds both.
**Fix:** extract into `/opt/jarvis/core`, `chown -R jarvis:jarvis dist`,
`sudo -u jarvis pnpm build`, then `cd /opt/jarvis/deploy && docker compose up -d
--build api worker`, then `systemctl restart jarvis-runner`.
**Lesson:** "compose said Running" is not "the new code is deployed". Check for a
file you just added inside the container before believing a deploy.

### The console has been reporting a build state from a file nobody updates
**Symptom:** the Control Center build bar sat at S5 / 37 steps / plan_sha
`b02f8f8` while the repo was on S25 / 40 steps — 21 hours stale.
**Cause:** the bar fetches `/PROGRESS.json`, served from
`/opt/jarvis/control-center/PROGRESS.json`, which is a **copy** published by
`scripts/progress-publish.sh`. That script is run by hand, and its own comment
tells you to run it "in the same breath" as updating `PROGRESS.json` — an
instruction, not a mechanism. It was run once and never again. Note also that
`deploy-control-center.sh` rsyncs `--delete`, so a console deploy REMOVES the
published copy unless it is re-published afterwards.
**Fix (not yet done — see BLOCKED.md):** serve the file from one source rather
than copying it, or publish on every state change. Until then, run
`scripts/progress-publish.sh` after every `progress-sync.mjs` AND after every
console deploy.
**Lesson:** a second copy of the truth, kept in step by a documented habit, is
the orphan pattern this plan keeps naming. The bar was not wrong about anything
except which file it was reading.

### The `to_e164` in `site.yaml` is not the number the outbound dial uses
**Symptom:** with `telnyx.connection_id` finally pinned, a real outbound dial
returned `422 10004 Missing required parameter /from`.
**Cause:** `placeCall` in `src/outbound.ts` reads `whatsapp.owner_e164` and
`whatsapp.jarvis_e164` for a **phone call**. The phone pair lives under
`telnyx.from_e164` / `telnyx.to_e164`; `whatsapp.jarvis_e164` is blank, so the
`from` went out empty. Only a real dial finds this — every fake-mode test passes,
because `FAKE` returns before `telnyxDial` is reached.
**Fix (in flight — see BLOCKED.md):** read the telnyx pair for voice.
**Second trap on the retry:** `placeCall` refuses when `attempts > 0`
("Jarvis does not redial"), and `reasonsToCall` skips any task that already has
an `outbound_calls` row. So re-testing needs the row reset —
`UPDATE outbound_calls SET state='wanted', blocked_reason=NULL, attempts=0` — not
just another sweep.

### Deleting a test project needs eight tables and one circular link
**Symptom:** suite cleanup aborted on `tasks_project_id_fkey`, leaving the
project, its tasks and its auth profiles behind for the next run to trip over.
**Cause:** everything with a foreign key to `tasks` has to go first
(`task_transitions`, `task_events`, `task_attempts`, `task_checkpoints`,
`task_context`, `artifacts`, `outbound_calls`, `schedule_runs`,
`call_turns.handover_task_id`), plus `issues` — and `tasks.blocked_by_issue_id`
points BACK at `issues`, so one of the two links must be nulled before either
row can go. `user_action_requests` hangs off `issues` as well.
**Fix:** see `cleanup()` in `scripts/s25-routing-test.sh`, which does it in the
working order. `SELECT conname FROM pg_constraint WHERE confrelid =
'tasks'::regclass` is how to regenerate the list rather than guessing it.

### A suite failed on the consequence of its own second case
**Symptom:** after S25, `s11-recovery-test` reported 18 failures with
`attempts=0` and `phases_kept=0` for every case after the second.
**Cause:** case 2 deliberately provokes a subscription limit. S25 made that mark
the profile spent for five hours, and dev has exactly one usable engine, so every
later case parked with "every engineering route is spent" before running.
**Fix:** `clearqueue()` now also clears `quota_json` for subscription profiles.
**Lesson:** when a step changes what a failure MEANS, the suites that provoke
that failure on purpose need their fixtures re-read, not just their assertions.

---

### The outbound sweep never looks at a `wanted` row
**Symptom:** the S23 dial defect was fixed and deployed, the failed
`outbound_calls` row was reset to `state='wanted', attempts=0` exactly as the
blocker said to, and then nothing happened. No dial, no log line, no error. The
row sat at `wanted` through many sweeps.
**Cause:** `sweepOutboundCalls` has two sources and `wanted` is neither of them.
It iterates `reasonsToCall`, which **skips any task that already has an
`outbound_calls` row** — and the reset row is that row — and then it picks up
`state='blocked'` rows whose `retry_after` has passed. A `wanted` row created by
nothing is unreachable: `wantCall` produces one and hands it straight to
`placeCall` in the same pass, so it never has to be swept.
**Fix:** to re-place a call, put the row on the retry path rather than at the
start: `state='blocked', retry_after=now() - interval '1 minute', attempts=0`.
The next sweep re-checks quiet hours through `mayDial` and places it, which also
means the retry is exercised by the same code that would run at 08:00 rather
than by a hand-written call into `placeCall`.
**Lesson:** "reset it to the initial state" assumes the initial state is one the
system polls. Read the sweep before choosing which state to reset to — an
unreachable row is indistinguishable from a broken sweep.

---

### A delivered call is not a ringing phone
**Symptom:** the first successful outbound dial. Telnyx returned 200 with a real
`call_control_id`, the sweep logged `ringing`, and Enrique reported no call. He
then corrected it: the call did arrive, it just never rang.
**Cause:** not Jarvis. The handset silenced it — the shape of iOS **Silence
Unknown Callers**, which delivers an unknown number straight to voicemail. The
evidence was already in the logs and was misread twice: we received **only**
`call.hangup` for that leg, never `call.initiated`, `call.ringing` or
`call.answered`, and the hangup landed ~31s after the dial, matching the
`timeout_secs: 30` in `telnyxDial`. That is a call that was delivered and never
picked up, not a call that failed to leave.
**Fix:** the Telnyx number has to be a known contact on the handset. Recorded in
BLOCKED.md, because it is a setting on Enrique's phone and nothing in the repo
can do it.
**Lesson:** two of them. First, "the API accepted it" and "the phone rang" are
separated by an entire carrier and a device the code cannot see — S23's Done-when
says *rings* for exactly that reason. Second, the missing webhooks were the
diagnosis and they were sitting in `docker logs` the whole time: when a call ends
with only a hangup event, ask what never happened before asking what broke.

---

### One sweep dialled twice, and the carrier stopped the second one
**Symptom:** placing one call produced two. The `blocked_task` dial succeeded,
and in the same sweep a `security_event` dial went out and came back
`403 90042 OB profile channel limit exceeded`.
**Cause:** `sweepOutboundCalls` walks every reason it finds and calls `placeCall`
on each, with nothing between them. An open `security_event` issue — "[telnyx]
rejected a call from an unrecognised number" — was a second legitimate reason, so
two calls left within a second of each other. Telnyx's outbound profile channel
limit is what actually prevented a double ring; the pager rule in plan §17 did
not, because nothing in the sweep enforces one call at a time.
**Fix:** none yet — recorded, not fixed, and the concurrency question belongs to
S33 (notification policy) rather than to a fix smuggled into S23.
**Lesson:** a per-call decision does not add up to a per-sweep decision. "Is this
a reason to ring?" was answered six ways correctly, and the question nobody asked
was "how many times may the phone ring in one pass?".

---

### The em-dashes were never mis-encoded; the header was missing
**Symptom:** `PROGRESS.json` appeared to contain `â€"` where an em-dash belonged,
which looks exactly like a write path that is not using UTF-8.
**Cause:** the file was clean the whole time — on Windows, on the box, and in the
published copy: zero mojibake bytes, five real U+2014. Caddy served it from the
static file server as `Content-Type: application/json` with **no charset**, under
`X-Content-Type-Options: nosniff`. A browser with nothing to sniff and no charset
to obey falls back to its locale default, and cp1252 renders the three UTF-8
bytes of an em-dash as exactly `â€"`.
**Fix:** `/PROGRESS.json` is routed to the API, which sends
`application/json; charset=utf-8`.
**Lesson:** check the bytes before you go looking for the encoder. `grep -c` for
the mojibake sequence in the actual file takes ten seconds and would have pointed
at the transport immediately; "something in the write path" was a plausible story
about a file that was never wrong.

---

### GitHub acknowledged the commit and then served the old file
**Symptom:** the S26 live test passed 11/11, and the very next run failed three
assertions — with the PREVIOUS run's `AGENTS.md` printed as the actual value. The
run after that passed again.
**Cause:** not the code. `PUT /repos/.../contents/AGENTS.md` returned 200 with a
commit sha, and a `GET` of the same path microseconds later returned the blob
that was there before. The Contents API is eventually consistent on read-back;
the first run had no prior file to serve, which is why creating passed and
replacing flaked.
**Fix:** the test reads back until it matches the canonical row, bounded at eight
attempts with 750ms between, and prints how many reads it took. Converging after
three is information; never converging is a real failure.
**How it was confirmed rather than assumed:** the sabotage round. With
`githubPutFile` returning a fake success without writing, the failure was
**exactly** the same three assertions with exactly the same actual value — which
is what proved the flake had been a stale read of a write that did happen, and
not a write that silently did not.
**Lesson:** a read-after-write against someone else's API is not a read of your
own database. If a test asserts on a remote resource it just changed, it has to
converge on the expected value or say it could not — reading once and re-running
on failure is how a real regression gets classified as a flake.

---

### The Supervisor read project instructions from a key nothing writes
**Symptom:** none. That is the point. Every project-scoped conversation Jarvis
has ever had was missing the project's own rules, and nothing anywhere said so.
**Cause:** the project-context builder in `runSupervisorTurn` selected
`config_versions` where `key = 'instructions'`. Nothing has ever written that
key — one read, no writer, zero rows in production. The template line was
conditional, so an empty result rendered nothing at all, which is
indistinguishable from a project that genuinely has no instructions.
**Found by:** reading the code on the way to S27, not by a failure. It surfaced
only because S26 gave instructions a real home
(`project_instructions_versions`), and the obvious next question — "so who reads
them?" — had the answer "nobody, and the thing that tried was pointed at the
wrong table".
**Fix:** `projectContextFor` reads the latest row from
`project_instructions_versions`, canonical per ADR 018, and says "no project
instructions have been written yet" when there are none, so absence is visible
rather than silent. Extracted from `runSupervisorTurn` so it can be asserted
without a model call. The body goes in whole; it used to be JSON-stringified and
cut at 800 characters, and a Supervisor handed the first two thirds of a
project's rules will confidently break the last third.
**Lesson:** a dead read is invisible in a way a dead write is not. Nothing
errors, nothing logs, and the feature simply never happens. When a table is
added, grep for its readers; when a read is added, grep for its writers. A
`SELECT` whose `WHERE` clause no `INSERT` can satisfy is a silent feature-off
switch, and the only way it shows up is somebody asking who consumes this.

---

### The canonical row and the committed file differed by one newline
**Symptom:** after routing S26 onboarding through S27's single write function,
the offline suite stayed 59/59 green and the LIVE test failed one assertion:
"the committed bytes are the canonical row, exactly". It had also stopped
converging — nine read-backs, all mismatching.
**Cause:** `applyInstructionsChange` does `args.body.trim()` before storing, and
the renderer ends the file with a newline. The commit was sending
`rendered.body`. So the row lost the trailing newline, the file kept it, and the
two differed by one character.
**Fix:** the commit reads the stored row back and sends that. ADR 018 says the
file is a rendering of the row; committing what was stored makes that true by
construction instead of by two code paths happening to agree. It converges on
the first read now, which is itself the tell — the polling loop existed for
GitHub's eventual consistency, and a mismatch that survives nine reads was never
eventual consistency.
**Lesson:** two places that "produce the same bytes" produce the same bytes
until one of them normalises. If a value must be byte-identical in two systems,
one of them has to be the source and the other has to read it — not re-derive
it. And note which suite caught this: the offline one could not, because both
its halves came from the same variable.

---

### Two writers bypassed the versioning path, and every test stayed green
**Symptom:** none, again. S27's suite asserted the versioning function
thoroughly and could not see that two other places wrote the same tables
directly.
**Cause:** `product.ts` (the schedule-edit route) and `supervisor.ts` (S26
onboarding) each had their own `INSERT`. The schedule one also computed
`version` with `max(version)` over the key across EVERY project, so two projects
with a same-named schedule shared one sequence. The onboarding one had no
provenance and skipped the placeholder guard.
**Fix:** both call `applyConfigChange` / `applyInstructionsChange`. The suite now
reads `src/` and asserts that exactly one file contains an `INSERT INTO` either
version table.
**Lesson:** "everything goes through one function" is an architectural claim, and
an architectural claim needs an architectural test. No amount of behavioural
testing of the right path can see the wrong path — the tests and the bypass do
not touch. Grepping your own source in a test feels crude and is the only thing
that actually holds the invariant.

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

---

### Five defects reached him at once, all above the layer the tests covered
**Symptom:** Enrique tried to create a project by voice. Six turns, no project.
He was answered "remembered: I want to create a project called Test Project",
then asked for confidentiality and production status on a project he had called
personal, then read the classifier's own notes aloud in the third person — "He
wants to create…", "The user asks…", "The message is a fragment with no clear
subject" — and finally told that neither name "matches any project in the
existing list".
**Cause:** five separate defects, and one thing they had in common. The router
had no category for creating a project, so the request could only land in
`capture`; its prompt said an unknown project name makes a segment `ambiguous`,
which is backwards for a request to CREATE one; `segment.reason` (a diagnostic
field) was wired into the question asked back to him; `classifyInbox` received
the current utterance and nothing else, so a fragment three turns in had no
subject; and the Supervisor prompt described only the professional case, so with
no type recorded it asked for the professional four.
**Why the tests were green:** S26 had 59 offline assertions and 11 live ones,
and every one of them drove `runTool` directly. They prove the onboarding tools
work. They are structurally incapable of seeing whether anything ever CALLS
them — and nothing did. A sixth defect was mine: rendering `AGENTS.md` demanded
twenty answers while the plan asks eight, and "just use the defaults" had no
representation, so even a perfectly routed request could not have finished.
**Fix:** a `create_project` category that hands the utterance to the desk where
the onboarding tools live; a question built from his own words; the last eight
turns given to the classifier; the prompt teaching type-first; and
`project_onboarding_defaults`, which answers how a project is BUILT and never
what it IS. Then the tests that were missing: one driving `ingestUserMessage`
end to end, and one putting his six real sentences through the LIVE classifier.
**Lesson:** a test that starts below the layer that failed cannot fail. When a
step's Done-when says "by voice", the test has to start where the voice does —
and if that is expensive, the expense is the point. Ask what the suite would
still pass with if the feature were entirely unreachable; if the answer is
"everything", the suite is measuring the wrong end.

---

### A CHECK constraint rejected every verdict and nothing said so
**Symptom:** the new `create_project` route worked perfectly — message routed,
project created, correct reply — and `inbox_events.route_category` was null for
every one of them.
**Cause:** `inbox_events_route_category_check` still listed the original five
categories plus `mixed`. Every `create_project` UPDATE violated it and threw.
The write is wrapped in `.catch(() => undefined)`, on the correct reasoning that
a routing RECORD must never take a message down — so the throw was swallowed and
the behaviour was flawless with no trace of itself.
**Why it matters more than it looks:** `routing.ts` opens by saying "Wrong
routing is invisible otherwise, and the documented way to find the bug is to
read a day of verdicts." A verdict that cannot be written is that sentence
quietly failing, and the next routing bug would have been undiagnosable.
**Fix:** migration 031 widens the constraint. The catch still cannot throw and
can no longer be silent — it logs the category and the reason.
**Lesson:** adding a value to an enum in code means adding it everywhere the
value is stored. And a deliberate catch is a decision to lose information: it is
right often enough to be worth keeping, and it must always say what it lost.
This was found only because a null column looked odd next to nineteen passing
assertions — the suite and the record disagreed, and the suite was the one that
was wrong.

---

### Three probes lied because MSYS rewrote the path
**Symptom:** an ad-hoc `docker compose run -e JARVIS_FAKE_MODEL_SCRIPT=/app/...`
reported that the classifier was never invoked at all. It led to a conclusion,
briefly reported as fact, that an entire test was passing through a degradation
path and proving nothing.
**Cause:** Git Bash rewrote `/app/scripts/fixtures/x.json` into
`C:/Program Files/Git/app/scripts/fixtures/x.json`. The fake found no script,
returned an empty string, and the router recorded "no model route answered".
Every `*-test.sh` in this repo exports `MSYS_NO_PATHCONV=1` and
`MSYS2_ARG_CONV_EXCL='*'` for exactly this reason; a command typed directly into
the shell has neither.
**Fix:** export both before any ad-hoc `docker compose` invocation, or put the
command in a `.sh` like every suite already does.
**Lesson:** this is the third time path conversion has cost real time in one
session, and the first time it produced a false FINDING rather than a failed
command — which is much worse. A diagnostic tool that is not configured like the
thing it is diagnosing is not measuring the same system. When a probe contradicts
a passing suite, suspect the probe first.

---

### A stray container claimed every task and looked like a regression
**Symptom:** immediately after a change to the engineering ladder, S1 went 14/23
and S25 went 5/12. Every failing task was parked with "Claude Code: claude is not
installed on this host" — the message from the new runtime-availability check,
which looked exactly like the new code parking things it should not.
**Cause:** not the code. A one-shot `docker compose run` runner from
`s28-park-test.sh` was still alive, and that suite deliberately runs with
`JARVIS_HARNESS=claude` so it can exercise the real selection path. The stray
container polled the same queue as every other suite, claimed their tasks first,
and correctly parked them for a binary that is not in the dev image. `docker ps`
showed `jarvis-dev-runner-run-<hash>` with `JARVIS_HARNESS=claude` in its
environment.
**Fix:** `docker rm -f` the strays; both suites went straight back to 23/23 and
12/12 with no code change at all.
**Lesson:** the dev stack has one queue and any number of runners, so a container
left behind by one suite silently competes with the next — and it fails in a way
that reads as a regression in whatever you just changed. Before believing a
sudden broad failure, run `docker ps` and check WHO is running and with what
environment. Suites that deviate from the fake harness are the dangerous ones to
leave lying around.

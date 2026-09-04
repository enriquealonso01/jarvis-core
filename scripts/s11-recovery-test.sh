#!/usr/bin/env bash
# S11 — five distinct mid-run failures, each recovering correctly, none losing
# work. Plus L2: restart with work queued and one running, order preserved.
#
# The failure text the fake harness prints is what a real harness prints. The
# runner classifies from that text, so this asserts the classifier rather than
# asserting a class the fixture handed over.
set -uo pipefail
cd "$(dirname "$0")/.."

# Git Bash on Windows rewrites anything shaped like a unix path in an argument
# into a Windows path, so `-e JARVIS_FAKE_MODEL_SCRIPT=/app/scripts/...` reached
# the container as `C:/Program Files/Git/app/scripts/...`. The fixture then
# failed to load, the fake model answered with nothing, and the suite reported a
# product failure ("no reviewer route answered") for a bug that was entirely in
# the shell. It cost an afternoon twice. Suites must not depend on which shell
# started them.
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
COMPOSE="docker compose -f deploy/compose.dev.yaml"
PSQL="$COMPOSE exec -T postgres psql -U jarvis -d jarvis -tAX"

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; echo "        expected: $2"; echo "        actual:   $3"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
contains(){ case "$3" in *"$2"*) ok "$1";; *) bad "$1" "contains '$2'" "$3";; esac; }

q() { $PSQL -c "$1" | tr -d '\r'; }

# Each case must be the ONLY thing the one-shot runner can claim. A retryable
# failure leaves its task queued, so without this the next case's runner picks up
# the previous case's task and the new one never runs at all — which reads as
# "0 attempts" rather than as interference.
clearqueue() {
  # The lane is no longer cleared. Cancelling every queued heavy task reached
  # into other sessions - compose pins name: jarvis-dev, so every worktree on
  # this machine shares one database. RUNNER_TASK_ID removes the reason to.
  # And the engine's quota. S25 made a subscription limit mark the profile spent
  # for five hours, which is right in production and fatal here: case 2 provokes
  # exactly that limit, so without this every case after it parks with "every
  # engineering route is spent" and reports zero attempts — a suite failing on
  # the consequence of its own second case.
  q "UPDATE auth_profiles SET quota_json = NULL WHERE auth_type='subscription_login';" >/dev/null
}

newtask() {
  clearqueue
  q "INSERT INTO tasks (project_id,title,objective,state,lane,priority)
     SELECT id,'$1','x','queued','heavy','normal' FROM projects WHERE slug='dev-sandbox'
     RETURNING id;" | grep -oiE '^[0-9a-f-]{36}$' | head -1
}
# Pointed at one task, so nothing has to be cancelled to make it claimable.
# Takes the id as its second argument; every caller already has one.
runfail() {
  $COMPOSE run --rm --no-deps -T -e RUNNER_ONCE=1 -e RUNNER_TASK_ID="$2" -e RUNNER_IDLE_EXIT_MS=8000 \
    -e JARVIS_HARNESS=fake:fail -e JARVIS_FAKE_FAILURE="$1" -e JARVIS_HEARTBEAT_MS=1500 \
    runner >/tmp/s11.log 2>&1
}

# --- the five failures, one at a time ------------------------------------
# kind | expected class | expected end state | retryable
# NOTE: this must NOT be called inside $( ). A command substitution runs in a
# subshell, so every check() inside it increments a COPY of pass/fail that is
# then thrown away, and its output is swallowed by whatever consumes the
# capture. Three cases' class assertions were invisible and could not affect the
# total — decoration, exactly what the rules warn about. The task id comes back
# through a variable instead.
LAST_TASK=""
one_failure() {
  local kind="$1" cls="$2" state="$3" label="$4"
  echo
  echo "=== $label ==="
  local t; t=$(newtask "S11 $kind")
  LAST_TASK="$t"
  runfail "$kind" "$t"
  local got_cls got_state phases
  got_cls=$(q "SELECT COALESCE(error_class,'-') FROM task_attempts WHERE task_id='$t' ORDER BY n DESC LIMIT 1;")
  got_state=$(q "SELECT state FROM tasks WHERE id='$t';")
  phases=$(q "SELECT count(*) FROM task_events WHERE task_id='$t' AND type='phase';")
  echo "  class=$got_cls state=$got_state phases_kept=$phases"
  check "classified as $cls" "$cls" "$got_cls"
  check "ends $state" "$state" "$got_state"
  check "the work it did before failing is kept" "3" "$phases"
}

echo "########## the five mid-run failures ##########"

# 1. revoke the credential
one_failure revoked provider.cred_expired waiting_for_provider "the credential is revoked mid-run"; T1="$LAST_TASK"
check "it is parked for Enrique, not retried" "1" \
  "$(q "SELECT count(*) FROM issues WHERE task_id='$T1' AND status='waiting_for_user';")"
contains "and the action says retrying will not help" "will not fix itself" \
  "$(q "SELECT COALESCE(required_action,'') FROM issues WHERE task_id='$T1' ORDER BY created_at DESC LIMIT 1;")"

# 2. the subscription limit
one_failure limit provider.cred_expired waiting_for_provider "the subscription hits its limit"; T2="$LAST_TASK"
check "exactly one attempt: it was not retried" "1" \
  "$(q "SELECT count(*) FROM task_attempts WHERE task_id='$T2';")"

# 3. fill the disk
one_failure disk resource.disk waiting_for_user "the disk fills up"; T3="$LAST_TASK"
check "not retried into a fuller disk" "1" \
  "$(q "SELECT count(*) FROM task_attempts WHERE task_id='$T3';")"

# 4. sever the network — retryable, so it goes back on the queue
echo
echo "=== the network is severed (retryable) ==="
T4=$(newtask "S11 network")
runfail network "$T4"
check "classified as network.timeout" "network.timeout" \
  "$(q "SELECT COALESCE(error_class,'-') FROM task_attempts WHERE task_id='$T4' ORDER BY n DESC LIMIT 1;")"
check "requeued rather than failed" "queued" "$(q "SELECT state FROM tasks WHERE id='$T4';")"
contains "and it says which retry" "network.timeout" "$(q "SELECT COALESCE(waiting_reason,'') FROM tasks WHERE id='$T4';")"
check "the lease was released for the next runner" "" \
  "$(q "SELECT COALESCE(lease_owner,'') FROM tasks WHERE id='$T4';")"
check "its phases survived the requeue" "3" \
  "$(q "SELECT count(*) FROM task_events WHERE task_id='$T4' AND type='phase';")"

# 5. a dirty exit stays harness.crash
echo
echo "=== an unrecognised dirty exit stays harness.crash ==="
T5=$(newtask "S11 crash")
runfail crash "$T5"
check "classified as harness.crash" "harness.crash" \
  "$(q "SELECT COALESCE(error_class,'-') FROM task_attempts WHERE task_id='$T5' ORDER BY n DESC LIMIT 1;")"
check "and is retryable" "queued" "$(q "SELECT state FROM tasks WHERE id='$T5';")"

# --- retries are bounded, and counted per class ---------------------------
echo
echo "=== retries are bounded by the class, not unlimited ==="
T6=$(newtask "S11 exhaust")
for i in 1 2 3 4; do
  q "UPDATE tasks SET state='queued', lease_owner=NULL, lease_until=NULL WHERE id='$T6';" >/dev/null
  runfail crash "$T6"
done
echo "  attempts=$(q "SELECT count(*) FROM task_attempts WHERE task_id='$T6';") state=$(q "SELECT state FROM tasks WHERE id='$T6';")"
check "it stops retrying at the taxonomy's limit" "failed_terminal" "$(q "SELECT state FROM tasks WHERE id='$T6';")"
check "after exactly the allowed number of attempts" "4" \
  "$(q "SELECT count(*) FROM task_attempts WHERE task_id='$T6';")"

# --- L2: restart with work in flight --------------------------------------
echo
echo "=== L2: restart with three queued and one running ==="
q "DELETE FROM task_context; DELETE FROM task_events; DELETE FROM task_transitions;
   DELETE FROM task_attempts; DELETE FROM tasks WHERE title LIKE 'L2 %';" >/dev/null
clearqueue
mk() { q "INSERT INTO tasks (project_id,title,objective,state,lane,priority)
          SELECT id,'$1','x','queued','heavy','normal' FROM projects WHERE slug='dev-sandbox'
          RETURNING id;" | grep -oiE '^[0-9a-f-]{36}$' | head -1; }
A=$(mk "L2 first");  sleep 1
B=$(mk "L2 second"); sleep 1
C=$(mk "L2 third");  sleep 1
D=$(mk "L2 running")
q "UPDATE tasks SET state='running', lease_owner='gone', lease_until=now()-interval '5 minutes',
   heartbeat_at=now()-interval '10 minutes' WHERE id='$D';" >/dev/null
# Counted by ID, not by title prefix.
#
# This counted every row ever titled "L2 %" - hundreds of them, from every past
# run of this suite - and was stable only because the lane was being cleared
# first. Once it was not, the number moved and the assertion failed while
# nothing had actually been lost. A suite should count what IT created.
$COMPOSE restart api >/dev/null 2>&1
JARVIS_STALL_SECONDS=5 $COMPOSE up -d --no-build worker >/dev/null 2>&1
# The recovery ladder waits before it requeues (rung 1 is `wait`, 30s, twice),
# so the budget covers the ladder's own backoffs. What is asserted is where the
# orphan ends up, not how quickly.
for _ in $(seq 1 150); do
  st=$(q "SELECT state FROM tasks WHERE id='$D';")
  [ "$st" = "queued" ] && break
  sleep 1
done
# Stopped so the assertions below read a state nothing is still changing - and
# then GIVEN BACK, at the end. Left stopped, it took the worker away from every
# suite that runs after this one in sweep.sh, which is the same fault
# s4-recovery and s4-drain carried.
$COMPOSE stop worker >/dev/null 2>&1
check "nothing was lost across the restart" "4"   "$(q "SELECT count(*) FROM tasks WHERE id IN ('$A','$B','$C','$D');")"
check "the orphaned running task was recovered to the queue" "queued" "$st"
# Scoped to THIS run's four ids. Matching on the title counted every earlier
# run's L2 rows too — the DELETE above cannot remove them (issues hold a foreign
# key to tasks), so a previous run's requeued orphan was the oldest queued row
# and the ordering assertion read its title instead of this run's.
check "and the three queued tasks are still queued" "3" \
  "$(q "SELECT count(*) FROM tasks WHERE id IN ('$A','$B','$C') AND state='queued';")"
check "order preserved: oldest first" "L2 first" \
  "$(q "SELECT title FROM tasks WHERE id IN ('$A','$B','$C','$D') AND state='queued'
        ORDER BY created_at LIMIT 1;")"

# The worker goes back the way it was found, with default stall seconds. After
# the checks, so restarting it cannot race what they read.
$COMPOSE up -d --no-build worker >/dev/null 2>&1

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

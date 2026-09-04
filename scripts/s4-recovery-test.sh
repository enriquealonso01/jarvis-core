#!/usr/bin/env bash
# S4 test 2, minus systemd: a runner killed mid-run must lose nothing.
#
# The plan says "systemctl restart jarvis-runner mid-run -> watchdog stalls,
# recovers, requeues from checkpoint". systemd is only the thing that kills the
# process; the behaviour under test is the watchdog's, and it is identical if
# the process dies for any other reason. So the runner is killed outright here —
# a harder case than a clean restart, since there is no draining.
#
# What must be true afterwards: the task is back on the queue, it walked the
# documented states to get there, its lease is clear, the issue that was raised
# was resolved, and a second runner finishes the work. Nothing disappears.
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

cleanup() {
  docker rm -f "$RUNNER_CT" >/dev/null 2>&1
  # PUT THE WORKER BACK.
  #
  # This suite stops the worker on purpose - it needs to watch a stalled task
  # recover without one interfering - and the old cleanup left it stopped and
  # removed. It runs seventh of about a hundred in the sweep, so every suite
  # after it ran with no worker at all, and anything needing a task to progress
  # failed for a reason that had nothing to do with what it was testing.
  #
  # Measured, by starting the worker and changing no code: s1-harness 16/7 ->
  # 23/0, s2-task-create 21/3 -> 24/0, s3-routing 28/2 -> 30/0, s4-drain 6/5 ->
  # 11/0, s11-recovery 14/12 -> 26/0. A suite that borrows a shared service owes
  # it back, and this one was borrowing it for the rest of the run.
  $COMPOSE up -d --no-build worker >/dev/null 2>&1
}
trap cleanup EXIT

# NOTE FOR WHOEVER FIXES THIS SUITE.
#
# It has a real race and its result depends on what the worker was doing when it
# started: across four runs it gave 11/7, 10/8, 6/12 and 4/14 with no code change
# between them. The watchdog that requeues a stalled task lives in the worker, so
# the middle section needs one running - but with one running the requeue can
# happen before the suite observes the "running, with nobody running it" state it
# asserts on first. Stopping the worker at the start fixes that assertion and
# breaks the whole requeue cascade instead.
#
# Deliberately NOT papered over here. This change makes exactly one fix - the
# suite now returns the worker it borrows, in cleanup - because that was costing
# every suite after it in the sweep. The race is its own problem and wants
# somebody to decide what the suite is really asserting.

BEFORE_STALL_ISSUES=$(q "SELECT count(*) FROM issues WHERE dedupe_key = 'worker.crash:heavy';")

# The victim runner is pointed at THIS task and no other.
#
# RUNNER_ONCE=1 claims the oldest queued heavy task, so a leftover from another
# suite took the slot and the fixture below sat in `queued` for the full 40
# second wait - twelve assertions then described a recovery that never had
# anything to recover.
#
# The obvious remedy is to cancel everything queued first, and it is the wrong
# one: compose pins `name: jarvis-dev`, so every worktree on this machine shares
# one database, and cancelling "everything queued" reaches into other sessions'
# runs. I nearly shipped exactly that before queue-stomping-test landed and
# named it - it is the reason results here have been a coin flip. RUNNER_TASK_ID
# removes the reason to destroy anything.

TASK=$(q "INSERT INTO tasks (project_id, title, objective, state, lane, priority)
          SELECT id, 'A run that gets killed', 'Run long enough to be interrupted, then finish.',
                 'queued', 'heavy', 'normal' FROM projects WHERE slug = 'dev-sandbox'
          RETURNING id;" | grep -oiE '^[0-9a-f-]{36}$' | head -1)
echo "task: $TASK"

# ---------------------------------------------------------------- the first run
echo
echo "=== a runner claims it and starts working ==="
RUNNER_CT=jarvis-dev-victim-runner
docker rm -f "$RUNNER_CT" >/dev/null 2>&1
$COMPOSE run --rm --no-deps -d --name "$RUNNER_CT" \
  -e RUNNER_ID=victim-1 -e RUNNER_ONCE=1 -e RUNNER_TASK_ID="$TASK" -e RUNNER_IDLE_EXIT_MS=8000 \
  -e JARVIS_HARNESS=fake:context -e JARVIS_HEARTBEAT_MS=1500 \
  -e JARVIS_FAKE_CONTEXT_WAIT_MS=120000 -e JARVIS_FAKE_CONTEXT_HOLD_MS=120000 \
  -e JARVIS_SILENCE_LIMIT_MS=180000 -e JARVIS_RUN_LIMIT_MS=600000 \
  runner >/dev/null 2>&1

for _ in $(seq 1 40); do
  st=$(q "SELECT state FROM tasks WHERE id = '$TASK';")
  [ "$st" = "running" ] && break
  sleep 1
done
check "the task is running before we kill anything" "running" "$st"
check "it has a lease owner" "victim-1" "$(q "SELECT COALESCE(lease_owner,'') FROM tasks WHERE id = '$TASK';")"
check "and exactly one attempt so far" "1" "$(q "SELECT count(*) FROM task_attempts WHERE task_id = '$TASK';")"
# Work already done that must survive: the runner writes a checkpoint when it
# delivers context, so give it one to lose.
q "INSERT INTO task_context (task_id, body, attached_state) VALUES ('$TASK', 'do not lose this', 'running');" >/dev/null
for _ in $(seq 1 20); do
  cps=$(q "SELECT count(*) FROM task_checkpoints WHERE task_id = '$TASK';")
  [ "$cps" != "0" ] && break
  sleep 1
done
check "there is work-in-progress worth losing (a checkpoint)" "1" "$cps"

# ----------------------------------------------------------------- kill it dead
echo
echo "=== the runner is killed mid-run ==="
docker kill "$RUNNER_CT" >/dev/null 2>&1
sleep 1
check "the runner process is gone" "" "$(docker ps -q -f name=$RUNNER_CT | tr -d '\n')"
check "the task is still marked running, with nobody running it" "running" \
  "$(q "SELECT state FROM tasks WHERE id = '$TASK';")"

# ------------------------------------------------------------- the watchdog acts
echo
echo "=== the watchdog notices and requeues ==="
JARVIS_STALL_SECONDS=5 $COMPOSE up -d --no-build worker >/dev/null 2>&1
for _ in $(seq 1 60); do
  st=$(q "SELECT state FROM tasks WHERE id = '$TASK';")
  [ "$st" = "queued" ] && break
  sleep 1
done
echo "  state after watchdog: $st"
check "the task is back on the queue" "queued" "$st"
check "it walked the documented states to get there" "running>stalled>recovering>queued" \
  "$(q "SELECT string_agg(to_state,'>' ORDER BY at, id) FROM task_transitions
        WHERE task_id = '$TASK' AND to_state IN ('running','stalled','recovering','queued')
          AND at >= (SELECT min(at) FROM task_transitions WHERE task_id='$TASK' AND to_state='running');")"
# S18b: the requeue now comes from a rung of the recovery ladder, and the cause
# names which one. It used to read "requeued from the latest checkpoint" — the
# checkpoint is still there and still resumed from (asserted just below, and by
# the second runner finishing the work), but the sentence belongs to the ladder.
contains "and it says which recovery rung requeued it" "recovery rung" \
  "$(q "SELECT cause FROM task_transitions WHERE task_id = '$TASK' AND to_state = 'queued'
        ORDER BY at DESC LIMIT 1;")"
check "the dead runner's lease was released" "" \
  "$(q "SELECT COALESCE(lease_owner,'') FROM tasks WHERE id = '$TASK';")"
check "the checkpoint from the killed run survived" "1" \
  "$(q "SELECT count(*) FROM task_checkpoints WHERE task_id = '$TASK';")"
check "and so did the context nobody had acted on" "1" \
  "$(q "SELECT count(*) FROM task_context WHERE task_id = '$TASK';")"

echo
echo "--- the stall was reported, then closed ---"
# One MORE than there was, and the status of the one THIS run raised. A resolved
# issue does not absorb the next occurrence, so the dedupe key accumulates a row
# per run: the bare count read 4, and the bare status query returned four rows
# joined by newlines and compared unequal to "resolved".
check "an issue was raised for the stall" "$((BEFORE_STALL_ISSUES + 1))" \
  "$(q "SELECT count(*) FROM issues WHERE dedupe_key = 'worker.crash:heavy';")"
check "and resolved once recovery worked" "resolved" \
  "$(q "SELECT status FROM issues WHERE dedupe_key = 'worker.crash:heavy'
        ORDER BY created_at DESC LIMIT 1;")"

# ------------------------------------------------------- a second runner finishes
echo
echo "=== a fresh runner picks it up and finishes the work ==="
$COMPOSE stop worker >/dev/null 2>&1
$COMPOSE run --rm --no-deps -T \
  -e RUNNER_ID=survivor-1 -e RUNNER_ONCE=1 -e RUNNER_TASK_ID="$TASK" -e RUNNER_IDLE_EXIT_MS=40000 \
  -e JARVIS_HARNESS=fake -e JARVIS_HEARTBEAT_MS=1500 \
  runner >/tmp/s4-runner2.log 2>&1

state=$(q "SELECT state FROM tasks WHERE id = '$TASK';")
branch=$(q "SELECT COALESCE(branch,'') FROM tasks WHERE id = '$TASK';")
echo "  final state=$state branch=$branch"
check "the task completed" "succeeded" "$state"
check "on a second attempt, not by restarting the first" "2" \
  "$(q "SELECT count(*) FROM task_attempts WHERE task_id = '$TASK';")"
check "the killed attempt is still on record" "1" \
  "$(q "SELECT count(*) FROM task_attempts WHERE task_id = '$TASK' AND n = 1;")"

# The effect in the world, not the row about it.
show=$($COMPOSE run --rm --no-deps -T runner sh -c \
  "git -C /var/lib/jarvis/projects/dev-sandbox/repo show --stat $branch -- JARVIS_FAKE_RUN.md 2>/dev/null || echo MISSING" \
  2>/dev/null | tr -d '\r')
contains "and the work really landed in the repo" "JARVIS_FAKE_RUN.md" "$show"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

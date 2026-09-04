#!/usr/bin/env bash
# S4 test 2, the half that only real hardware exposed: a runner told to STOP
# must not record its own shutdown as the task's failure.
#
# On the box, `systemctl restart jarvis-runner` sends SIGTERM to the whole
# cgroup (KillMode=control-group is the default), so the harness dies with 143.
# The runner read that as harness.crash, marked the task failed_terminal, and
# threw away the whole run. This reproduces that with a plain SIGTERM to the
# runner container and asserts the task survives to be requeued instead.
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

CT=jarvis-dev-drain-runner
# A suite that borrows a shared service owes it back.
#
# This one stopped the worker and removed it, and never brought it back - the
# same fault s4-recovery-test.sh carried, found the same way: every suite that
# runs after it in sweep.sh then runs with no worker at all, and reports failures
# that have nothing to do with what it is testing.
#
# Measured earlier by starting the worker and changing no code: s1-harness
# 16/7 -> 23/0, s2-task-create 21/3 -> 24/0, s3-routing 28/2 -> 30/0, s4-drain
# 6/5 -> 11/0, s11-recovery 14/12 -> 26/0.
#
# Restored with the default stall seconds rather than this suite's five, because
# what the next suite needs is an ordinary worker, not this one's fixture.
cleanup() {
  docker rm -f "$CT" >/dev/null 2>&1
  $COMPOSE stop worker >/dev/null 2>&1
  $COMPOSE rm -f worker >/dev/null 2>&1
  $COMPOSE up -d --no-build worker >/dev/null 2>&1
}
trap cleanup EXIT

TASK=$(q "INSERT INTO tasks (project_id, title, objective, state, lane, priority)
          SELECT id, 'A run that gets drained', 'Run long enough to be told to stop.',
                 'queued','heavy','normal' FROM projects WHERE slug='dev-sandbox'
          RETURNING id;" | grep -oiE '^[0-9a-f-]{36}$' | head -1)
echo "task: $TASK"

echo
echo "=== a run is in flight ==="
docker rm -f "$CT" >/dev/null 2>&1
$COMPOSE run --rm --no-deps -d --name "$CT" \
  -e RUNNER_ID=drain-1 -e RUNNER_ONCE=1 -e RUNNER_IDLE_EXIT_MS=8000 \
  -e JARVIS_HARNESS=fake:context -e JARVIS_HEARTBEAT_MS=1500 \
  -e JARVIS_FAKE_CONTEXT_WAIT_MS=120000 -e JARVIS_SILENCE_LIMIT_MS=180000 \
  -e JARVIS_RUN_LIMIT_MS=600000 runner >/dev/null 2>&1

for _ in $(seq 1 40); do
  st=$(q "SELECT state FROM tasks WHERE id='$TASK';")
  [ "$st" = "running" ] && break
  sleep 1
done
check "the task is running" "running" "$st"

echo
echo "=== the runner is told to stop, the way systemd tells it ==="
# systemd's KillMode=control-group signals EVERY process in the unit's cgroup,
# not just the leader — which is why the harness dies too. `docker stop` signals
# only PID 1, so it does NOT reproduce the bug: the harness survives and the
# runner never reaches its drain path. Signal the whole process group instead.
# NOTE: `kill -TERM -1` is NOT enough — Linux excludes PID 1 from kill(-1), so
# the runner (the leader) never receives it and only the harness dies. That is
# a different scenario entirely. Walk /proc and signal every pid, leader
# included, which is what a cgroup-wide TERM actually does.
docker exec "$CT" sh -c 'for p in $(ls /proc | grep -E "^[0-9]+$"); do kill -TERM "$p" 2>/dev/null; done' >/dev/null 2>&1
for _ in $(seq 1 25); do
  docker ps -q -f name="$CT" | grep -q . || break
  sleep 1
done
docker rm -f "$CT" >/dev/null 2>&1
sleep 1
state=$(q "SELECT state FROM tasks WHERE id='$TASK';")
ec=$(q "SELECT COALESCE(error_class,'-') FROM task_attempts WHERE task_id='$TASK' ORDER BY n DESC LIMIT 1;")
summary=$(q "SELECT COALESCE(summary,'-') FROM task_attempts WHERE task_id='$TASK' ORDER BY n DESC LIMIT 1;")
echo "  state=$state error_class=$ec"
echo "  summary=$summary"

# The bug this test exists for.
check "the task is NOT failed_terminal" "false" "$([ "$state" = "failed_terminal" ] && echo true || echo false)"
check "the shutdown was not recorded as a harness crash" "false" \
  "$([ "$ec" = "harness.crash" ] && echo true || echo false)"
check "the task is left running for the watchdog" "running" "$state"
contains "and the attempt says why" "drained" "$summary"
check "the checkpoint calls it a drain" "drained" \
  "$(q "SELECT COALESCE(payload->>'stop_reason','-') FROM task_checkpoints WHERE task_id='$TASK' ORDER BY at DESC LIMIT 1;")"

echo
echo "=== the watchdog requeues it, and a new runner finishes the work ==="
JARVIS_STALL_SECONDS=5 $COMPOSE up -d --no-build worker >/dev/null 2>&1
# S18b put a LADDER in front of the requeue: rung 1 waits 30s (twice), rung 2
# nudges, and only rung 3 requeues. Sixty seconds was enough when the watchdog
# requeued on sight and is not enough now — the assertion is about where the
# task ends up, not how fast it gets there, so the budget covers the ladder's
# own backoffs rather than the ladder being made impatient to suit the test.
for _ in $(seq 1 180); do
  st=$(q "SELECT state FROM tasks WHERE id='$TASK';")
  [ "$st" = "queued" ] && break
  sleep 1
done
check "requeued" "queued" "$st"
check "it walked the documented states" "running>stalled>recovering>queued" \
  "$(q "SELECT string_agg(to_state,'>' ORDER BY at,id) FROM task_transitions
        WHERE task_id='$TASK' AND to_state IN ('running','stalled','recovering','queued')
          AND at >= (SELECT min(at) FROM task_transitions WHERE task_id='$TASK' AND to_state='running');")"
$COMPOSE stop worker >/dev/null 2>&1

# Long enough to outlast the ladder's cooling-off period. Rung 3 requeues with
# `lease_until = now() + 15s` — the backoff IS a lease, which is what lets a rung
# cool off without a scheduler of its own — so a runner that gave up after eight
# seconds went home before the task it came for was claimable.
$COMPOSE run --rm --no-deps -T -e RUNNER_ID=after-drain -e RUNNER_ONCE=1 \
  -e RUNNER_IDLE_EXIT_MS=40000 -e JARVIS_HARNESS=fake -e JARVIS_HEARTBEAT_MS=1500 \
  runner >/tmp/s4-drain-runner2.log 2>&1
branch=$(q "SELECT COALESCE(branch,'') FROM tasks WHERE id='$TASK';")
check "the work completed on a second attempt" "succeeded" "$(q "SELECT state FROM tasks WHERE id='$TASK';")"
check "two attempts on record, the drained one kept" "2" \
  "$(q "SELECT count(*) FROM task_attempts WHERE task_id='$TASK';")"
show=$($COMPOSE run --rm --no-deps -T runner sh -c \
  "git -C /var/lib/jarvis/projects/dev-sandbox/repo show --stat $branch -- JARVIS_FAKE_RUN.md 2>/dev/null || echo MISSING" \
  2>/dev/null | tr -d '\r')
contains "and the work really landed" "JARVIS_FAKE_RUN.md" "$show"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

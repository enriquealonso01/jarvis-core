#!/usr/bin/env bash
# S1 acceptance: drive every fake-harness variant through the real runner and
# assert on the database, not on the runner's own claims.
#
#   ./scripts/s1-harness-test.sh            # all variants
#   ./scripts/s1-harness-test.sh ok crash   # a subset
#
# Each variant gets a fresh queued heavy task, a one-shot runner container, and
# then a query. Nothing here reads stdout for a verdict: the runner's opinion of
# itself is exactly what v1 believed.
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

# S11 made several failure classes retryable, so a failed variant leaves its task
# QUEUED. Without this, the next variant's one-shot runner claims the previous
# variant's leftover and the new task is never run at all — which shows up as an
# empty error_class rather than as interference.
clearqueue() {
  q "UPDATE tasks SET state='cancelled', lease_owner=NULL, lease_until=NULL
     WHERE lane='heavy' AND state IN ('queued','preparing','running');" >/dev/null
}

new_task() {
  clearqueue
  q "INSERT INTO tasks (project_id, title, objective, state, lane, priority)
     SELECT id, '$1', '$2', 'queued', 'heavy', 'normal' FROM projects WHERE slug = 'dev-sandbox'
     RETURNING id;" | grep -oiE '^[0-9a-f-]{36}$' | head -1
}

run_variant() {
  local harness="$1" silence="${2:-}" runlimit="${3:-}"
  $COMPOSE run --rm --no-deps -T \
    -e RUNNER_ONCE=1 \
    -e RUNNER_IDLE_EXIT_MS=8000 \
    -e JARVIS_HARNESS="$harness" \
    ${silence:+-e JARVIS_SILENCE_LIMIT_MS=$silence} \
    ${runlimit:+-e JARVIS_RUN_LIMIT_MS=$runlimit} \
    -e JARVIS_HEARTBEAT_MS=2000 \
    runner >/tmp/s1-runner.log 2>&1
}

VARIANTS="${*:-ok crash slow runaway noop escape errorresult}"

for v in $VARIANTS; do
  echo
  echo "=== variant: $v ==="
  id=$(new_task "s1 $v" "Fix the login bug in app.js and commit it.")
  case "$v" in
    ok)      run_variant "fake" ;;
    noop)    run_variant "fake:noop" ;;
    crash)   run_variant "fake:crash" ;;
    escape)  run_variant "fake:escape" ;;
    errorresult) run_variant "fake:errorresult" ;;
    slow)    run_variant "fake:slow" 6000 ;;
    runaway) run_variant "fake:runaway" 60000 8000 ;;
  esac

  state=$(q "SELECT state FROM tasks WHERE id = '$id';")
  ec=$(q "SELECT COALESCE(error_class,'') FROM task_attempts WHERE task_id = '$id' ORDER BY n DESC LIMIT 1;")
  summary=$(q "SELECT COALESCE(summary,'') FROM task_attempts WHERE task_id = '$id' ORDER BY n DESC LIMIT 1;")
  path=$(q "SELECT string_agg(to_state, '>' ORDER BY at, id) FROM task_transitions WHERE task_id = '$id';")
  changed=$(q "SELECT COALESCE((payload->>'changed'),'') FROM task_checkpoints WHERE task_id = '$id' ORDER BY at DESC LIMIT 1;")
  audits=$(q "SELECT count(*) FROM audit_events WHERE action = 'harness.escape_blocked' AND metadata->>'task_id' = '$id';")
  branch=$(q "SELECT COALESCE(branch,'') FROM tasks WHERE id = '$id';")
  arts=$(q "SELECT count(*) FROM artifacts WHERE path LIKE '%${id:0:8}%';")

  ec_state="$state"
  echo "  state=$state path=$path error_class=$ec changed=$changed audits=$audits"
  echo "  summary=$summary"

  case "$v" in
    ok)
      check "task reaches succeeded" "succeeded" "$state"
      check "transition path" "preparing>running>succeeded" "$path"
      check "checkpoint records a change" "true" "$changed"
      check "transcript artifact registered" "1" "$arts"
      # The effect in the world, not the row about it: the commit must exist.
      commit=$(q "SELECT 1;" >/dev/null; $COMPOSE run --rm --no-deps -T runner \
        node -e "const{execSync}=require('child_process');const b='$branch';
                 try{process.stdout.write(execSync('git -C /var/lib/jarvis/projects/dev-sandbox/repo show --stat '+b+' -- JARVIS_FAKE_RUN.md',{encoding:'utf8'}))}catch(e){process.stdout.write('MISSING')}" 2>/dev/null | tr -d '\r')
      contains "the branch really carries the new file" "JARVIS_FAKE_RUN.md" "$commit"
      ;;
    noop)
      check "task reaches succeeded" "succeeded" "$state"
      check "checkpoint records no change" "false" "$changed"
      contains "summary says so" "no changes" "$summary"
      ;;
    crash)
      # S11 gave every failure class its own retry budget. harness.crash is
      # retryable three times, so the FIRST failure requeues rather than ending
      # the task — that is the taxonomy, not a regression.
      check "requeued for retry, not failed on the first crash" "queued" "$state"
      check "error class" "harness.crash" "$ec"
      ;;
    slow)
      check "requeued for retry (process.stuck retries 3)" "queued" "$state"
      check "error class" "process.stuck" "$ec"
      ;;
    runaway)
      # agent.loop is "no retry; stall; Issue" — a looping agent loops again.
      check "stalled for Enrique, never retried" "stalled" "$state"
      check "error class" "agent.loop" "$ec"
      ;;
    errorresult)
      # The real claude emits is_error with result:"" — a blank summary here
      # means a failed task nobody can explain without opening the transcript.
      check "requeued for retry" "queued" "$ec_state"
      check "error class" "harness.crash" "$ec"
      if [ -n "$summary" ]; then ok "the failure has a summary at all"; else bad "the failure has a summary at all" "non-empty" "(empty)"; fi
      contains "and it names what the harness reported" "error_max_turns" "$summary"
      check "the checkpoint records the subtype" "error_max_turns"         "$(q "SELECT COALESCE(payload->>'result_subtype','') FROM task_checkpoints WHERE task_id = '$id' ORDER BY at DESC LIMIT 1;")"
      check "and records is_error" "true"         "$(q "SELECT COALESCE(payload->>'is_error','') FROM task_checkpoints WHERE task_id = '$id' ORDER BY at DESC LIMIT 1;")"
      ;;
    escape)
      check "task fails terminally" "failed_terminal" "$state"
      check "error class" "security.isolation" "$ec"
      check "the attempt is audited" "1" "$audits"
      ;;
  esac
done

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

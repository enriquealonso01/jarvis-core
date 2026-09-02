#!/usr/bin/env bash
# S3c acceptance: feedback typed while a task is running reaches that run,
# without restarting it, and never disappears.
#
# The proof is not "a row was marked delivered". It is that the harness read his
# words during the run and committed a file containing them, while the task
# stayed on the same attempt the whole time.
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
API="http://127.0.0.1:8080"
COOKIE=/tmp/s3c-cookie.txt

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; echo "        expected: $2"; echo "        actual:   $3"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
contains(){ case "$3" in *"$2"*) ok "$1";; *) bad "$1" "contains '$2'" "$3";; esac; }

q() { $PSQL -c "$1" | tr -d '\r'; }

curl -s -o /dev/null -c "$COOKIE" -X POST "$API/api/auth/login" \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:8080' \
  -d '{"email":"dev@jarvis.local","password":"dev-password-1234"}'
CONV=$(q "SELECT id FROM conversations WHERE project_id IS NULL ORDER BY created_at LIMIT 1;")
say() {
  curl -s -b "$COOKIE" -X POST "$API/api/conversations/$CONV/messages" \
    -H 'Content-Type: application/json' -H 'Origin: http://localhost:8080' \
    -d "$(printf '%s' "$1" | python -c 'import json,sys;print(json.dumps({"body":sys.stdin.read()}))')"
}

# A task the runner can really execute: dev-sandbox is the only project with a
# repo, so the commit at the end is a real commit on a real branch.
TASK=$(q "INSERT INTO tasks (project_id, conversation_id, title, objective, state, lane, priority)
          SELECT id, '$CONV', 'The long job', 'Run for a while and act on anything Enrique adds.',
                 'queued', 'heavy', 'normal' FROM projects WHERE slug = 'dev-sandbox'
          RETURNING id;" | grep -oiE '^[0-9a-f-]{36}$' | head -1)
SHORT=${TASK:0:8}
echo "task under test: $TASK (short $SHORT)"

# A second, unrelated queued task, so "belongs to a different task" is testable.
OTHER=$(q "INSERT INTO tasks (project_id, conversation_id, title, objective, state, lane, priority)
           SELECT id, '$CONV', 'The other job', 'Something else entirely.',
                  'queued', 'heavy', 'normal' FROM projects WHERE slug = 'alpha-web'
           RETURNING id;" | grep -oiE '^[0-9a-f-]{36}$' | head -1)
OSHORT=${OTHER:0:8}
echo "other task:      $OTHER (short $OSHORT)"

# The router needs to name a real id, and the fixture cannot know it in advance.
# Write a run-specific script the fake router reads.
# A stale bind-mount attempt once left this path behind as a DIRECTORY, so the
# fixture silently failed to write and every assertion read as a routing bug.
FIX=/tmp/s3c-fixture-$$.json
rm -rf "$FIX"
cat > "$FIX" <<JSON
{
  "classifier": [
    {"match": "also check the csv export",
     "json": {"reason": "adds to work already running",
              "segments": [{"category": "work", "task": "$SHORT",
                            "text": "Also check whether this could affect the CSV export.",
                            "reason": "a further thing to check on the run in flight"}]}},
    {"match": "one more thing for the other job",
     "json": {"reason": "adds to a different, queued task",
              "segments": [{"category": "work", "task": "$OSHORT",
                            "text": "One more thing for the other job: use the new logo.",
                            "reason": "belongs to the other task, not the running one"}]}},
    {"match": "attach this to task ffffffff",
     "json": {"reason": "he named a task I do not have",
              "segments": [{"category": "work", "task": "ffffffff",
                            "text": "attach this to task ffffffff please",
                            "reason": "no such task"}]}}
  ],
  "supervisor": []
}
JSON
# Drop it on the shared volume as an overlay. No container restart, no env
# change: an earlier version of this test recreated the API with its own
# JARVIS_FAKE_MODEL_SCRIPT and left it that way, and every suite that ran
# afterwards was answered from this fixture. dev-seed deletes the overlay, so a
# crashed run heals itself.
overlay_put() { $COMPOSE run --rm --no-deps -T -e "OVERLAY_JSON=$(cat "$1")" runner sh -c 'printf %s "$OVERLAY_JSON" > /var/lib/jarvis/fake-overlay.json' >/dev/null 2>&1; }
overlay_clear() { $COMPOSE run --rm --no-deps -T runner   sh -c 'rm -f /var/lib/jarvis/fake-overlay.json' >/dev/null 2>&1; }
trap overlay_clear EXIT
if [ ! -s "$FIX" ]; then echo "FIXTURE NOT WRITTEN at $FIX -- aborting" >&2; exit 1; fi
overlay_put "$FIX"
echo "  overlay bytes in container: $($COMPOSE run --rm --no-deps -T runner sh -c 'wc -c < /var/lib/jarvis/fake-overlay.json' 2>/dev/null | tr -d '
' | tail -1)"

# ------------------------------------------------------------------ the run
echo
echo "=== a run is started, and feedback is sent while it is in flight ==="
$COMPOSE run --rm --no-deps -T -e RUNNER_ONCE=1 -e RUNNER_IDLE_EXIT_MS=8000 \
  -e JARVIS_HARNESS=fake:context -e JARVIS_HEARTBEAT_MS=1500 \
  -e JARVIS_FAKE_CONTEXT_WAIT_MS=45000 -e JARVIS_SILENCE_LIMIT_MS=120000 \
  runner >/tmp/s3c-runner.log 2>&1 &
RUNNER_PID=$!

# Wait until the task is genuinely running before saying anything.
for _ in $(seq 1 40); do
  st=$(q "SELECT state FROM tasks WHERE id = '$TASK';")
  [ "$st" = "running" ] && break
  sleep 1
done
echo "  task state before feedback: $st"
check "the task really is running before we speak" "running" "$st"

reply=$(say "Also check the CSV export while you are in there")
echo "  reply=$reply"
check "the feedback was attached to the running task" "1" \
  "$(q "SELECT count(*) FROM task_context WHERE task_id = '$TASK';")"
check "and recorded the state it interrupted" "running" \
  "$(q "SELECT attached_state FROM task_context WHERE task_id = '$TASK' LIMIT 1;")"
check "no new task was created for it" "0" \
  "$(q "SELECT count(*) FROM tasks WHERE title ILIKE '%CSV%';")"
contains "the reply says it will be picked up" "picked up at the next checkpoint" "$reply"

echo
echo "=== a second message belongs to a DIFFERENT task ==="
reply2=$(say "One more thing for the other job, use the new logo")
echo "  reply=$reply2"
check "it landed on the other task" "1" \
  "$(q "SELECT count(*) FROM task_context WHERE task_id = '$OTHER';")"
check "the running task was not touched by it" "1" \
  "$(q "SELECT count(*) FROM task_context WHERE task_id = '$TASK';")"
check "the other task is still queued, not started" "queued" \
  "$(q "SELECT state FROM tasks WHERE id = '$OTHER';")"

echo
echo "=== a task id that does not exist asks, it does not attach ==="
# Counted BEFORE and compared, not against a literal 2. `SELECT count(*) FROM
# task_context` is every row the database has ever held, so the assertion only
# held on a freshly seeded stack and read as a product failure on any other.
BEFORE_CTX=$(q 'SELECT count(*) FROM task_context;')
reply3=$(say "Please attach this to task ffffffff")
echo "  reply=$reply3"
check "nothing was attached anywhere new" "$BEFORE_CTX" "$(q 'SELECT count(*) FROM task_context;')"
contains "and it asks which task" "Which task did you mean" "$reply3"

echo
echo "=== waiting for the run to finish ==="
wait $RUNNER_PID || true
state=$(q "SELECT state FROM tasks WHERE id = '$TASK';")
branch=$(q "SELECT COALESCE(branch,'') FROM tasks WHERE id = '$TASK';")
echo "  final state=$state branch=$branch"

check "the run finished successfully" "succeeded" "$state"
check "it was never restarted: exactly one attempt" "1" \
  "$(q "SELECT count(*) FROM task_attempts WHERE task_id = '$TASK';")"
check "and never left running to do it" "0" \
  "$(q "SELECT count(*) FROM task_transitions WHERE task_id = '$TASK'
        AND to_state IN ('stalled','recovering','retry_scheduled','queued','preparing')
        AND at > (SELECT min(at) FROM task_transitions WHERE task_id = '$TASK' AND to_state = 'running');")"
check "the context is marked delivered" "1" \
  "$(q "SELECT count(*) FROM task_context WHERE task_id = '$TASK' AND delivered_at IS NOT NULL;")"
check "delivered on attempt 1, the one that was already running" "1" \
  "$(q "SELECT COALESCE(delivered_attempt,-1) FROM task_context WHERE task_id = '$TASK' LIMIT 1;")"
check "a checkpoint records the delivery" "1" \
  "$(q "SELECT count(*) FROM task_checkpoints WHERE task_id = '$TASK'
        AND payload->>'outcome' = 'context_delivered';")"

echo
echo "--- the effect in the world: did the HARNESS actually read it? ---"
show=$($COMPOSE run --rm --no-deps -T runner sh -c \
  "git -C /var/lib/jarvis/projects/dev-sandbox/repo show $branch:CONTEXT_SEEN.md 2>/dev/null || echo MISSING" \
  2>/dev/null | tr -d '\r')
echo "  CONTEXT_SEEN.md = $(printf '%s' "$show" | head -c 200)"
contains "the committed file carries his words" "CSV export" "$show"
contains "and says it arrived mid-run" "while this task was already running" "$show"

echo
echo "=== feedback after the task has finished is kept, not swallowed ==="
before=$(q 'SELECT count(*) FROM task_context;')
reply4=$(say "Also check the CSV export while you are in there")
echo "  reply=$reply4"
check "it was still stored" "$((before+1))" "$(q 'SELECT count(*) FROM task_context;')"
check "against the finished task, marked as arriving then" "succeeded" \
  "$(q "SELECT attached_state FROM task_context WHERE task_id = '$TASK' ORDER BY created_at DESC LIMIT 1;")"
check "it is still pending, so it is visibly unacted-on" "1" \
  "$(q "SELECT count(*) FROM task_context WHERE task_id = '$TASK' AND delivered_at IS NULL;")"
contains "and the reply says it was not acted on" "it was not acted on" "$reply4"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

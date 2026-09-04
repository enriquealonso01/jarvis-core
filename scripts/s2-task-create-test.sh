#!/usr/bin/env bash
# S2 acceptance: does a sentence in the console become a correctly-scoped task,
# and does a non-work sentence leave the queue alone?
#
# Every sentence goes through the real console endpoint
# (POST /api/conversations/:id/messages), the real inbox, and a real Supervisor
# turn. Only the model itself is scripted (src/fakemodel.ts) — the tool, the
# resolver, the refusals and the provenance are the code that ships.
#
# Verdicts come from the database. The assistant's own reply is never the test.
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
COOKIE=/tmp/s2-cookie.txt

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; echo "        expected: $2"; echo "        actual:   $3"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
contains(){ case "$3" in *"$2"*) ok "$1";; *) bad "$1" "contains '$2'" "$3";; esac; }
differs(){ if [ "$2" != "$3" ]; then ok "$1"; else bad "$1" "something other than '$2'" "$3"; fi; }

q() { $PSQL -c "$1" | tr -d '\r'; }

# Everything this suite counts has to be counted from HERE, not from the
# beginning of the database. "Burst one" is the same title every run and
# `supervisor.tool` accumulates a row per call forever, so a bare count says 9
# where it means 3 and reads as the Supervisor having created work three times
# over. The timestamp comes from Postgres, not the shell, so it is the same
# clock the rows are stamped with.
RUN_START=$(q "SELECT now();")

login() {
  curl -s -o /dev/null -c "$COOKIE" -X POST "$API/api/auth/login" \
    -H 'Content-Type: application/json' -H 'Origin: http://localhost:8080' \
    -d '{"email":"dev@jarvis.local","password":"dev-password-1234"}'
}

# The console's own thread: project_id IS NULL, so nothing scopes the task for
# the model. That is the hard case and the one worth testing.
conv_id() { q "SELECT id FROM conversations WHERE project_id IS NULL ORDER BY created_at LIMIT 1;"; }

say() {
  curl -s -b "$COOKIE" -X POST "$API/api/conversations/$CONV/messages" \
    -H 'Content-Type: application/json' -H 'Origin: http://localhost:8080' \
    -d "$(printf '{"body":%s}' "$(printf '%s' "$1" | python -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")"
}

login
CONV=$(conv_id)
echo "conversation: $CONV"

# ---------------------------------------------------------------- 1. real work
echo
echo "=== 1. work request becomes a heavy task ==="
before=$(q "SELECT count(*) FROM tasks;")
MSG="In Alpha Web, fix the login button and open a PR"
reply=$(say "$MSG")
after=$(q "SELECT count(*) FROM tasks;")
row=$(q "SELECT t.state||'|'||t.lane||'|'||t.priority||'|'||p.slug||'|'||
             (t.conversation_id IS NOT NULL)||'|'||(t.origin_inbox_id IS NOT NULL)
         FROM tasks t JOIN projects p ON p.id = t.project_id ORDER BY t.created_at DESC LIMIT 1;")
obj=$(q "SELECT objective FROM tasks ORDER BY created_at DESC LIMIT 1;")
path=$(q "SELECT string_agg(from_state||'->'||to_state, ' ' ORDER BY at, id) FROM task_transitions
          WHERE task_id = (SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1);")
echo "  row=$row"
echo "  reply=$reply"
check "exactly one task created" "$((before+1))" "$after"
check "state|lane|priority|project|conv|inbox" "queued|heavy|high|alpha-web|true|true" "$row"
check "state machine walked" "captured->classified classified->queued" "$path"
differs "objective is not the raw message echoed" "$MSG" "$obj"
contains "objective says what done looks like" "pull request" "$obj"

# ------------------------------------------------------------- 2. not work
echo
echo "=== 2. a thing to remember creates NO task ==="
before=$(q "SELECT count(*) FROM tasks;")
memb=$(q "SELECT count(*) FROM memory_items;")
say "Remember the client prefers Tuesdays" >/dev/null
check "no task created" "$before" "$(q 'SELECT count(*) FROM tasks;')"
check "one memory item stored" "$((memb+1))" "$(q 'SELECT count(*) FROM memory_items;')"

# ------------------------------------------------------------- 3. ambiguous
echo
echo "=== 3. ambiguous project asks, creates nothing ==="
before=$(q "SELECT count(*) FROM tasks;")
reply=$(say "Please speed up the checkout")
echo "  reply=$reply"
check "no task created" "$before" "$(q 'SELECT count(*) FROM tasks;')"
contains "the turn says it could not" "could not" "$reply"
contains "and names both candidates" "alpha-mobile" "$reply"

# ------------------------------------------------------- 4. heavy, no project
echo
echo "=== 4. heavy work with no project is refused ==="
before=$(q "SELECT count(*) FROM tasks;")
reply=$(say "Please tidy up the logs")
echo "  reply=$reply"
check "no task created" "$before" "$(q 'SELECT count(*) FROM tasks;')"
contains "it asks which project" "heavy work needs a project" "$reply"

# ------------------------------------------------------- 5. echoed objective
echo
echo "=== 5. an objective that echoes the message is refused ==="
before=$(q "SELECT count(*) FROM tasks;")
reply=$(say "Make the header sticky")
echo "  reply=$reply"
check "no task created" "$before" "$(q 'SELECT count(*) FROM tasks;')"
contains "it says why" "copy of his message" "$reply"

# ------------------------------------------------------------------- 6. burst
echo
echo "=== 6. three messages in quick succession make three tasks ==="
before=$(q "SELECT count(*) FROM tasks;")
start=$(date +%s)
say "burst one"   >/dev/null &
say "burst two"   >/dev/null &
say "burst three" >/dev/null &
wait
elapsed=$(( $(date +%s) - start ))
echo "  sent 3 concurrently in ${elapsed}s"
check "three tasks created" "$((before+3))" "$(q 'SELECT count(*) FROM tasks;')"
burst_titles=$(q "SELECT count(DISTINCT title) FROM tasks WHERE title LIKE 'Burst %';")
check "none merged: three distinct titles" "3" "$burst_titles"
if [ "$burst_titles" != "3" ]; then
  # Intermittent, roughly 1 run in 10. Dump what actually happened so the next
  # occurrence is diagnosable instead of just a red line. See DEBUG_NOTES.
  echo "  --- burst diagnostics ---"
  q "SELECT COALESCE(title,'?')||' | '||state FROM tasks WHERE title LIKE 'Burst %' ORDER BY created_at;" | sed 's/^/      /'
  q "SELECT left(raw_text,24)||' -> '||COALESCE(route_category,'-')||' | '||COALESCE(routing_note,'-') FROM inbox_events WHERE raw_text ILIKE 'burst%' ORDER BY received_at;" | sed 's/^/      /'
fi
check "each carries its own inbox event" "3" \
  "$(q "SELECT count(DISTINCT origin_inbox_id) FROM tasks
        WHERE title LIKE 'Burst %' AND created_at >= '$RUN_START';")"
check "all three are queued heavy on alpha-web" "3" \
  "$(q "SELECT count(*) FROM tasks t JOIN projects p ON p.id=t.project_id
        WHERE t.title LIKE 'Burst %' AND t.state='queued' AND t.lane='heavy' AND p.slug='alpha-web';")"

# --------------------------------------------------- 7. the tool really ran
echo
echo "=== 7. tool calls are audited, not just claimed ==="
check "task_create audited once per created task" "4" \
  "$(q "SELECT count(*) FROM audit_events WHERE action='supervisor.tool' AND target='task_create'
        AND at >= '$RUN_START' AND (metadata->>'result') NOT LIKE 'ERROR%';")"
check "refusals audited too" "3" \
  "$(q "SELECT count(*) FROM audit_events WHERE action='supervisor.tool' AND target='task_create'
        AND at >= '$RUN_START' AND (metadata->>'result') LIKE 'ERROR%';")"

# --------------------------------------- 8. the effect, not the row about it
echo
echo "=== 8. a task created this way is really executed by the heavy lane ==="
say "Please wire it end to end" >/dev/null
tid=$(q "SELECT id FROM tasks WHERE title = 'Wire it end to end' ORDER BY created_at DESC LIMIT 1;")
check "the task is queued on the heavy lane" "queued|heavy"   "$(q "SELECT state||'|'||lane FROM tasks WHERE id = '$tid';")"

# Pointed at this task. This section used to cancel EVERY queued task on every
# lane so the one-shot runner would claim the one under test - which took out
# other sessions' work as well as earlier sections'.
$COMPOSE run --rm --no-deps -T -e RUNNER_ONCE=1 -e RUNNER_IDLE_EXIT_MS=8000 \
  -e RUNNER_TASK_ID="$tid" -e JARVIS_HARNESS=fake -e JARVIS_HEARTBEAT_MS=2000 \
  runner >/tmp/s2-runner.log 2>&1

state=$(q "SELECT state FROM tasks WHERE id = '$tid';")
branch=$(q "SELECT COALESCE(branch,'') FROM tasks WHERE id = '$tid';")
head=$(q "SELECT COALESCE(head_sha,'') FROM tasks WHERE id = '$tid';")
echo "  state=$state branch=$branch head=${head:0:8}"
check "the runner took it to succeeded" "succeeded" "$state"
contains "on its own branch" "jarvis/task-" "$branch"

# The world, not the database's opinion of the world.
show=$($COMPOSE run --rm --no-deps -T runner sh -c   "git -C /var/lib/jarvis/projects/dev-sandbox/repo show --stat $branch -- JARVIS_FAKE_RUN.md 2>/dev/null || echo MISSING"   2>/dev/null | tr -d '
')
contains "the commit really exists in the repo" "JARVIS_FAKE_RUN.md" "$show"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

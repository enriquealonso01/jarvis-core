#!/usr/bin/env bash
# S18b — the retrofit sweep: requirements that landed after their step shipped.
#
# The step exists because "a requirement written after its step finished has no
# moment at which anyone would apply it". So each item here is tested against
# the thing it was supposed to change, not against the fact that code exists.
#
# The one that matters most is the first: "Kill a run mid-investigation; the
# replacement worker continues the SAME HYPOTHESIS rather than forming a new
# one. This is the test that proves the checkpoint retrofit worked, and nothing
# else does."
set -uo pipefail
cd "$(dirname "$0")/.."
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

bash scripts/console-rebuild.sh >/dev/null || {
  echo "  FAIL  the console did not build — see /tmp/console-build.log"
  echo "==== 0 passed, 1 failed ===="; exit 1; }

clearqueue() {
  q "UPDATE tasks SET state='cancelled', lease_owner=NULL, lease_until=NULL
     WHERE lane='heavy' AND state IN ('queued','preparing','running');" >/dev/null
}

newtask() {
  clearqueue
  q "INSERT INTO tasks (project_id,title,objective,state,lane,priority)
     SELECT id,'$1','$2','queued','heavy','normal' FROM projects WHERE slug='dev-sandbox'
     RETURNING id;" | grep -oiE '^[0-9a-f-]{36}$' | head -1
}

runner() {
  $COMPOSE run --rm --no-deps -T -e RUNNER_ONCE=1 -e RUNNER_IDLE_EXIT_MS=8000 \
    -e JARVIS_HEARTBEAT_MS=1500 "$@" runner >/tmp/s18b.log 2>&1
}

# =========================================================== 1. checkpoints
echo "########## a checkpoint that records WHY, not just where ##########"
echo
T=$(newtask "S18b investigate this" "Find out why the cart total is wrong.")
runner -e JARVIS_HARNESS=fake:workflow -e JARVIS_FAKE_WORKFLOW=halt_late

CP=$(q "SELECT payload::text FROM task_checkpoints WHERE task_id='$T'
        AND payload ? 'current_hypothesis' ORDER BY at DESC LIMIT 1;")
echo "  checkpoint: $(printf '%s' "$CP" | head -c 200)"
for field in current_plan files_modified commands_executed test_results current_hypothesis next_intended_action; do
  case "$CP" in
    *"\"$field\""*) ok "  the checkpoint carries $field";;
    *) bad "  the checkpoint carries $field" "present" "missing";;
  esac
done
contains "  the hypothesis is the run's own, not a placeholder" "root_cause" \
  "$(q "SELECT COALESCE(payload->>'current_hypothesis','') FROM task_checkpoints
        WHERE task_id='$T' AND payload ? 'current_hypothesis' ORDER BY at DESC LIMIT 1;")"
contains "  and it says what it was about to do next" "plan" \
  "$(q "SELECT COALESCE(payload->>'next_intended_action','') FROM task_checkpoints
        WHERE task_id='$T' AND payload ? 'current_hypothesis' ORDER BY at DESC LIMIT 1;")"
# psql prints a boolean as `t`.
check "  the commands it ran are recorded, not its account of them" "t" \
  "$(q "SELECT jsonb_array_length(payload->'commands_executed') > 0 FROM task_checkpoints
        WHERE task_id='$T' AND payload ? 'current_hypothesis' ORDER BY at DESC LIMIT 1;")"

# --- and the resume path READS them -----------------------------------------
echo
echo "=== the replacement worker continues the same hypothesis ==="
# The halted run left phases up to `inspect`; resume and capture the prompt the
# harness is actually given.
q "UPDATE tasks SET state='queued', lease_owner=NULL, lease_until=NULL WHERE id='$T';" >/dev/null
runner -e JARVIS_HARNESS=fake:echoprompt
# Only the resume preamble, not the whole prompt: a failure that prints four
# thousand characters of transcript is a failure nobody reads.
PROMPT=$($COMPOSE run --rm --no-deps -T runner sh -c \
  "cat /var/lib/jarvis/artifacts/*/task-$(printf '%s' "$T" | cut -c1-8)-attempt-2.jsonl 2>/dev/null" 2>/dev/null \
  | grep -o 'THIS IS A RESUMED RUN.*HOW TO WORK' | head -c 1200)
contains "  the resumed run is told the previous hypothesis" "hypothesis was" "$PROMPT"
contains "  and told not to re-derive it" "do not re-derive" "$PROMPT"
contains "  and what it was about to do" "was about to" "$PROMPT"

# ====================================================== 2. the three classes
echo
echo "########## the three error classes that were in the taxonomy only ##########"
echo
for kind in cpu dependency repeat; do
  case "$kind" in
    cpu)        want="resource.cpu";        harness="-e JARVIS_HARNESS=fake:fail -e JARVIS_FAKE_FAILURE=cpu";;
    dependency) want="dependency.unavailable"; harness="-e JARVIS_HARNESS=fake:fail -e JARVIS_FAKE_FAILURE=dependency";;
    repeat)     want="agent.repeat";        harness="-e JARVIS_HARNESS=fake:repeat -e JARVIS_REPEAT_LIMIT=4";;
  esac
  T2=$(newtask "S18b $kind" "x")
  # shellcheck disable=SC2086
  runner $harness
  got=$(q "SELECT COALESCE(error_class,'-') FROM task_attempts WHERE task_id='$T2' ORDER BY n DESC LIMIT 1;")
  check "$want is classified" "$want" "$got"
done

# agent.repeat has an extra requirement: quote what was repeated.
T3=$(newtask "S18b repeat evidence" "x")
runner -e JARVIS_HARNESS=fake:repeat -e JARVIS_REPEAT_LIMIT=4
contains "the repeated action is quoted in the issue" "npm test -- cart" \
  "$(q "SELECT COALESCE(evidence->>'repeated_action','') FROM issues
        WHERE task_id='$T3' ORDER BY created_at DESC LIMIT 1;")"
check "and it is stalled rather than retried" "stalled" "$(q "SELECT state FROM tasks WHERE id='$T3';")"
check "with exactly one attempt" "1" "$(q "SELECT count(*) FROM task_attempts WHERE task_id='$T3';")"

# ================================================= 3. internal idempotency
echo
echo "########## a retried internal post does not create a second row ##########"
echo
SECRET=$(q "SELECT 1;" >/dev/null; echo "")
RID="s18b-$(date +%s)"
BODY='{"channel":"whatsapp","sender":"enrique","text":"S18b idempotency probe","request_id":"'"$RID"'"}'
before=$(q "SELECT count(*) FROM inbox_events WHERE raw_text = 'S18b idempotency probe';")
for i in 1 2 3; do
  $COMPOSE exec -T api node -e "
    const crypto=require('node:crypto');
    const body=process.argv[1];
    const sig=crypto.createHmac('sha256', process.env.INTERNAL_HMAC).update(body).digest('hex');
    fetch('http://127.0.0.1:8080/internal/inbox/ingest',{method:'POST',
      headers:{'Content-Type':'application/json','x-jarvis-internal':sig},body})
      .then(r=>r.text()).then(t=>console.log(t.slice(0,120)));
  " "$BODY" >/dev/null 2>&1
done
after=$(q "SELECT count(*) FROM inbox_events WHERE raw_text = 'S18b idempotency probe';")
check "three identical posts, one row" "$((before + 1))" "$after"
check "and the claim is recorded once" "1" \
  "$(q "SELECT count(*) FROM internal_requests WHERE request_id = '$RID';")"

# ========================================== 4 and 5: the ladder, the status bar
echo
a=$($COMPOSE run --rm --no-deps -T runner node --import tsx scripts/s18b-ladder-test.ts 2>&1); echo "$a"
b=$(node scripts/s18b-statusbar-test.mjs 2>&1); echo "$b"
sum() { printf '%s' "$1" | grep -oE '==== [0-9]+ passed, [0-9]+ failed ====' | tail -1; }
ap=$(sum "$a" | grep -oE '^==== [0-9]+' | grep -oE '[0-9]+'); af=$(sum "$a" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+')
bp=$(sum "$b" | grep -oE '^==== [0-9]+' | grep -oE '[0-9]+'); bf=$(sum "$b" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+')
pass=$(( pass + ${ap:-0} + ${bp:-0} ))
fail=$(( fail + ${af:-1} + ${bf:-1} ))

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

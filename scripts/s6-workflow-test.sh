#!/usr/bin/env bash
# S6 — the engineering workflow, and the honesty rules around it.
#
# The phases are asserted from task_events, because "the console can show it"
# means the rows exist, not that the harness printed something. The verdict
# assertions are the point of the step: a run that could not reproduce, or that
# is guessing, must NOT be recorded as a fix.
set -uo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f deploy/compose.dev.yaml"
PSQL="$COMPOSE exec -T postgres psql -U jarvis -d jarvis -tAX"

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; echo "        expected: $2"; echo "        actual:   $3"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
contains(){ case "$3" in *"$2"*) ok "$1";; *) bad "$1" "contains '$2'" "$3";; esac; }

q() { $PSQL -c "$1" | tr -d '\r'; }

newtask() {
  q "INSERT INTO tasks (project_id, title, objective, state, lane, priority)
     SELECT id, '$1', '$2', 'queued','heavy','normal' FROM projects WHERE slug='dev-sandbox'
     RETURNING id;" | grep -oiE '^[0-9a-f-]{36}$' | head -1
}

runit() {
  $COMPOSE run --rm --no-deps -T -e RUNNER_ONCE=1 -e RUNNER_IDLE_EXIT_MS=8000 \
    -e JARVIS_HARNESS=fake:workflow -e JARVIS_FAKE_WORKFLOW="$1" \
    -e JARVIS_HEARTBEAT_MS=1200 -e JARVIS_SILENCE_LIMIT_MS=120000 \
    ${2:+-e JARVIS_FAKE_RESUME_AT=$2} runner >/tmp/s6-runner.log 2>&1
}

# ------------------------------------------------------------------ happy path
echo "=== a complete run announces every phase ==="
T=$(newtask "S6 full loop" "There is a bug in the login flow. Find it, fix it, add a test.")
runit full
state=$(q "SELECT state FROM tasks WHERE id='$T';")
phases=$(q "SELECT string_agg(name,'>' ORDER BY at,id) FROM task_events WHERE task_id='$T' AND type='phase';")
echo "  state=$state"
echo "  phases=$phases"
check "the task succeeded" "succeeded" "$state"
check "all eleven phases were recorded" \
  "preserve>context>reproduce>inspect>root_cause>plan>change>tests>checks>commit>push" "$phases"
check "each phase is one row, not many" "11" \
  "$(q "SELECT count(*) FROM task_events WHERE task_id='$T' AND type='phase';")"
check "the task's phase column holds the last one" "push" "$(q "SELECT COALESCE(phase,'-') FROM tasks WHERE id='$T';")"
check "Jarvis's own scratch is NOT committed into the project" "0"   "$($COMPOSE run --rm --no-deps -T runner sh -c       "git -C /var/lib/jarvis/projects/dev-sandbox/repo ls-tree -r --name-only        \$(git -C /var/lib/jarvis/projects/dev-sandbox/repo rev-parse $(q "SELECT COALESCE(branch,'main') FROM tasks WHERE id='$T';")) 2>/dev/null | grep -c '^\.jarvis/' || true" 2>/dev/null | tr -d '' | tail -1)"
check "the verdict was recorded" "completed|true|high" \
  "$(q "SELECT verdict||'|'||reproduced||'|'||confidence FROM task_attempts WHERE task_id='$T' AND n=1;")"


# --------------------------------------------------------- cannot reproduce
echo
echo "=== a report it cannot reproduce is said, not faked ==="
T2=$(newtask "S6 unreproducible" "Sometimes the page is blank. Fix it.")
runit norepro
state2=$(q "SELECT state FROM tasks WHERE id='$T2';")
echo "  state=$state2  waiting_reason=$(q "SELECT COALESCE(waiting_reason,'-') FROM tasks WHERE id='$T2';" | head -c 90)"
check "it does NOT claim success" "false" "$([ "$state2" = "succeeded" ] && echo true || echo false)"
check "it asks rather than failing" "waiting_for_user" "$state2"
check "the verdict is recorded as not_reproducible" "not_reproducible" \
  "$(q "SELECT COALESCE(verdict,'-') FROM task_attempts WHERE task_id='$T2' AND n=1;")"
check "and reproduced is false" "f" "$(q "SELECT reproduced FROM task_attempts WHERE task_id='$T2' AND n=1;")"
check "it stopped at the reproduce phase" "reproduce" "$(q "SELECT COALESCE(phase,'-') FROM tasks WHERE id='$T2';")"
contains "an issue records what it tried" "the exact input" \
  "$(q "SELECT COALESCE(evidence::text,'') FROM issues WHERE task_id='$T2' ORDER BY created_at DESC LIMIT 1;")"

# ---------------------------------------------------------------- a guess
echo
echo "=== a guess is never recorded as a fix ==="
T3=$(newtask "S6 guess" "Something is slow. Make it fast.")
runit guess
state3=$(q "SELECT state FROM tasks WHERE id='$T3';")
echo "  state=$state3"
check "it does NOT claim success" "false" "$([ "$state3" = "succeeded" ] && echo true || echo false)"
check "it is held for review" "waiting_for_user" "$state3"
contains "and it is labelled a guess" "GUESS" \
  "$(q "SELECT COALESCE(waiting_reason,'') FROM tasks WHERE id='$T3';")"

# ------------------------------------------------------------- out of scope
echo
echo "=== a request outside the repo is declined, not sprawled into ==="
T4=$(newtask "S6 scope" "Also change the billing system in the other product.")
runit scope
check "it does not claim success" "waiting_for_user" "$(q "SELECT state FROM tasks WHERE id='$T4';")"
check "verdict out_of_scope" "out_of_scope" \
  "$(q "SELECT COALESCE(verdict,'-') FROM task_attempts WHERE task_id='$T4' AND n=1;")"
# "No commit" means the branch head did not move — not merely that the worktree
# looked clean, which is a weaker and different claim.
check "and it made no commit: the head did not move" "same" \
  "$(q "SELECT CASE WHEN (payload->>'head_sha') IS NOT DISTINCT FROM (payload->>'base_sha')
        THEN 'same' ELSE 'moved' END FROM task_checkpoints WHERE task_id='$T4' ORDER BY at DESC LIMIT 1;")"
check "and the worktree was left clean" "false" \
  "$(q "SELECT COALESCE(payload->>'changed','?') FROM task_checkpoints WHERE task_id='$T4' ORDER BY at DESC LIMIT 1;")"

# ------------------------------------------- tests already failing beforehand
echo
echo "=== a repo that was already red is reported, not claimed or blamed ==="
T5=$(newtask "S6 pre-existing" "The suite is failing. Fix the feature.")
runit prefail
check "it does not claim success" "waiting_for_user" "$(q "SELECT state FROM tasks WHERE id='$T5';")"
check "verdict pre_existing_failure" "pre_existing_failure" \
  "$(q "SELECT COALESCE(verdict,'-') FROM task_attempts WHERE task_id='$T5' AND n=1;")"
contains "and it says the suite was already red" "already red" \
  "$(q "SELECT COALESCE(waiting_reason,'') FROM tasks WHERE id='$T5';")"

# ---------------------------------------------------- no outcome file at all
echo
echo "=== a run that reports nothing is incomplete, not successful ==="
T6=$(newtask "S6 silent" "Do the thing.")
runit silent
check "it does not claim success" "waiting_for_user" "$(q "SELECT state FROM tasks WHERE id='$T6';")"
contains "and says what is unknown" "without writing .jarvis/outcome.json" \
  "$(q "SELECT COALESCE(waiting_reason,'') FROM tasks WHERE id='$T6';")"

# ------------------------------------------------------------- phase resume
echo
echo "=== a killed run resumes at the phase it reached, not from the start ==="
T7=$(newtask "S6 resume" "Fix the thing, in stages.")
runit halt
mid=$(q "SELECT COALESCE(phase,'-') FROM tasks WHERE id='$T7';")
midcount=$(q "SELECT count(*) FROM task_events WHERE task_id='$T7' AND type='phase';")
echo "  halted at=$mid after $midcount phases"
check "it got partway" "inspect" "$mid"
check "and recorded only the phases it reached" "4" "$midcount"
# Requeue and let it finish; the runner should tell the harness where to resume.
q "UPDATE tasks SET state='queued', lease_owner=NULL, lease_until=NULL, waiting_reason=NULL WHERE id='$T7';" >/dev/null
runit full root_cause
check "the resumed run finished" "succeeded" "$(q "SELECT state FROM tasks WHERE id='$T7';")"
check "on a second attempt" "2" "$(q "SELECT count(*) FROM task_attempts WHERE task_id='$T7';")"
check "the early phases were not repeated" "1" \
  "$(q "SELECT count(*) FROM task_events WHERE task_id='$T7' AND type='phase' AND name='preserve';")"
check "and the run reached the end" "push" "$(q "SELECT COALESCE(phase,'-') FROM tasks WHERE id='$T7';")"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

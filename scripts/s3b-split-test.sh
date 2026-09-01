#!/usr/bin/env bash
# S3b acceptance: one message, several destinations, source intact.
#
# The headline test for this step is the five-minute memo: one voice note naming
# three things becomes three destinations, in the right projects, with the
# original still whole and every derived thing pointing back at it.
#
# Everything is read out of the database. A summary line in the reply is not
# evidence that a task exists.
set -uo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f deploy/compose.dev.yaml"
PSQL="$COMPOSE exec -T postgres psql -U jarvis -d jarvis -tAX"
API="http://127.0.0.1:8080"
COOKIE=/tmp/s3b-cookie.txt

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; echo "        expected: $2"; echo "        actual:   $3"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
contains(){ case "$3" in *"$2"*) ok "$1";; *) bad "$1" "contains '$2'" "$3";; esac; }
lacks(){ case "$3" in *"$2"*) bad "$1" "NOT to contain '$2'" "$3";; *) ok "$1";; esac; }

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
echo "source thread: $CONV"

# ------------------------------------------------------- the five-minute memo
echo
echo "=== the five-minute memo: three destinations from one message ==="
MEMO="Quick brain dump: alpha web needs the checkout page fixed, also for alpha mobile I thought of a nicer onboarding, oh and next month we should review pricing"
tasks_before=$(q "SELECT count(*) FROM tasks;")
reply=$(say "$MEMO")
INBOX=$(q "SELECT id FROM inbox_events WHERE raw_text LIKE 'Quick brain dump%' ORDER BY received_at DESC LIMIT 1;")
echo "  inbox=$INBOX"
echo "  reply=$reply"

check "two tasks were created, not one and not three" "2" \
  "$(q "SELECT count(*) FROM tasks WHERE origin_inbox_id = '$INBOX';")"
check "one on alpha-web, one on alpha-mobile" "alpha-mobile,alpha-web" \
  "$(q "SELECT string_agg(DISTINCT p.slug, ',' ORDER BY p.slug) FROM tasks t
        JOIN projects p ON p.id = t.project_id WHERE t.origin_inbox_id = '$INBOX';")"
check "both are queued on the heavy lane" "2" \
  "$(q "SELECT count(*) FROM tasks WHERE origin_inbox_id = '$INBOX' AND state='queued' AND lane='heavy';")"
check "the third segment became memory, not a task" "1" \
  "$(q "SELECT count(*) FROM memory_items WHERE source_inbox_id = '$INBOX';")"
contains "and it kept his words" "review pricing" \
  "$(q "SELECT body FROM memory_items WHERE source_inbox_id = '$INBOX' LIMIT 1;")"

echo
echo "--- provenance: everything points back at the one event ---"
check "every derived task carries origin_inbox_id" "0" \
  "$(q "SELECT count(*) FROM tasks WHERE conversation_id IN
        (SELECT id FROM conversations WHERE created_from_inbox_id = '$INBOX')
        AND origin_inbox_id IS NULL;")"
check "two threads were opened from this event" "2" \
  "$(q "SELECT count(*) FROM conversations WHERE created_from_inbox_id = '$INBOX';")"
check "each task sits in its own project's thread" "2" \
  "$(q "SELECT count(*) FROM tasks t JOIN conversations c ON c.id = t.conversation_id
        WHERE t.origin_inbox_id = '$INBOX' AND c.project_id = t.project_id;")"

echo
echo "--- the source is intact ---"
check "still exactly one inbox event for the memo" "1" \
  "$(q "SELECT count(*) FROM inbox_events WHERE raw_text LIKE 'Quick brain dump%';")"
check "its raw text is unchanged, whole" "1" \
  "$(q "SELECT count(*) FROM inbox_events WHERE id = '$INBOX' AND raw_text = \$\$$MEMO\$\$;")"
check "it still carries its three segments" "3" \
  "$(q "SELECT jsonb_array_length(route_segments) FROM inbox_events WHERE id = '$INBOX';")"
check "and it is marked processed" "processed" \
  "$(q "SELECT processing_state FROM inbox_events WHERE id = '$INBOX';")"
check "the source thread is not where the work landed" "0" \
  "$(q "SELECT count(*) FROM tasks WHERE origin_inbox_id = '$INBOX' AND conversation_id = '$CONV';")"

echo
echo "--- the reply says what happened ---"
contains "names the alpha-web task"    "task in alpha-web"    "$reply"
contains "names the alpha-mobile task" "task in alpha-mobile" "$reply"
contains "and the thing it remembered" "remembered"           "$reply"

# ------------------------------------------------------------ single category
echo
echo "=== a capture creates memory and no task ==="
tb=$(q "SELECT count(*) FROM tasks;")
mb=$(q "SELECT count(*) FROM memory_items;")
say "Remember the client prefers Tuesdays" >/dev/null
check "no task" "$tb" "$(q 'SELECT count(*) FROM tasks;')"
check "one memory item" "$((mb+1))" "$(q 'SELECT count(*) FROM memory_items;')"

echo
echo "=== an instruction becomes a config task on the system lane ==="
say "From now on always ask me before deploying" >/dev/null
I2=$(q "SELECT id FROM inbox_events WHERE raw_text LIKE 'From now on always ask%' ORDER BY received_at DESC LIMIT 1;")
check "one task, system lane, jarvis-improvement" "system|jarvis-improvement" \
  "$(q "SELECT t.lane||'|'||p.slug FROM tasks t JOIN projects p ON p.id=t.project_id
        WHERE t.origin_inbox_id = '$I2';")"
check "not on the heavy lane" "0" \
  "$(q "SELECT count(*) FROM tasks WHERE origin_inbox_id = '$I2' AND lane = 'heavy';")"

# ------------------------------------------------------------- failure paths
echo
echo "=== a project that does not exist asks, and files nothing ==="
tb=$(q "SELECT count(*) FROM tasks;")
pb=$(q "SELECT count(*) FROM projects;")
reply=$(say "Please get that sorted in Zeppelin")
echo "  reply=$reply"
check "no task"    "$tb" "$(q 'SELECT count(*) FROM tasks;')"
check "no project" "$pb" "$(q 'SELECT count(*) FROM projects;')"
contains "the reply asks about it" "zeppelin" "$(printf '%s' "$reply" | tr 'A-Z' 'a-z')"

echo
echo "=== WORK naming a project that does not exist asks, it does not guess ==="
tb=$(q "SELECT count(*) FROM tasks;")
pb=$(q "SELECT count(*) FROM projects;")
reply=$(say "Can you ship the dashboard in Hindenburg this week")
I5=$(q "SELECT id FROM inbox_events WHERE raw_text LIKE 'Can you ship the dashboard%' ORDER BY received_at DESC LIMIT 1;")
echo "  reply=$reply"
check "no task was filed anywhere" "$tb" "$(q 'SELECT count(*) FROM tasks;')"
check "and none against this event" "0"   "$(q "SELECT count(*) FROM tasks WHERE origin_inbox_id = '$I5';")"
check "no project was invented" "$pb" "$(q 'SELECT count(*) FROM projects;')"
contains "the reply names what he said" "hindenburg" "$(printf '%s' "$reply" | tr 'A-Z' 'a-z')"
contains "and lists what does exist" "alpha-web" "$(printf '%s' "$reply" | tr 'A-Z' 'a-z')"

echo
echo "=== two unclear segments produce ONE question, not two ==="
reply=$(say "Two unclear things at once please")
echo "  reply=$reply"
check "still no tasks from it" "0" \
  "$(q "SELECT count(*) FROM tasks WHERE origin_inbox_id =
        (SELECT id FROM inbox_events WHERE raw_text LIKE 'Two unclear things%' ORDER BY received_at DESC LIMIT 1);")"
contains "one question is asked" "Which project is this for?" "$reply"
contains "and the rest is acknowledged, not asked again" "other part of that message needs placing" "$reply"

echo
echo "=== work and a question in one message: filed AND answered ==="
reply=$(say "Mixed message: alpha web needs the search box fixed, and remind me what the deploy steps are")
I3=$(q "SELECT id FROM inbox_events WHERE raw_text LIKE 'Mixed message%' ORDER BY received_at DESC LIMIT 1;")
echo "  reply=$reply"
check "the work half became a task" "1" \
  "$(q "SELECT count(*) FROM tasks WHERE origin_inbox_id = '$I3';")"
contains "and the question half got an answer" "deploy" "$(printf '%s' "$reply" | tr 'A-Z' 'a-z')"

echo
echo "=== no router verdict falls through to the Supervisor, as before S3 ==="
reply=$(say "Nothing in the router script matches this sentence at all")
I4=$(q "SELECT id FROM inbox_events WHERE raw_text LIKE 'Nothing in the router script%' ORDER BY received_at DESC LIMIT 1;")
echo "  reply=$reply"
check "verdict recorded as ambiguous" "ambiguous" \
  "$(q "SELECT route_category FROM inbox_events WHERE id = '$I4';")"
check "the message still reached processed" "processed" \
  "$(q "SELECT processing_state FROM inbox_events WHERE id = '$I4';")"
lacks "the router did not invent a destination" "task in " "$reply"
contains "the Supervisor answered instead" "assistant" "$reply"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

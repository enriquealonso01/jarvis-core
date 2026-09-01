#!/usr/bin/env bash
# S3a acceptance: is the route decision made, and is it written down?
#
# Every sentence goes through the real console endpoint, the real inbox and the
# real classifier. Only the model is scripted (src/fakemodel.ts). The verdict is
# read back off the inbox event, because the whole point of S3's Debug section
# is that a wrong route is invisible unless the decision was recorded.
set -uo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f deploy/compose.dev.yaml"
PSQL="$COMPOSE exec -T postgres psql -U jarvis -d jarvis -tAX"
API="http://127.0.0.1:8080"
COOKIE=/tmp/s3-cookie.txt

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; echo "        expected: $2"; echo "        actual:   $3"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
contains(){ case "$3" in *"$2"*) ok "$1";; *) bad "$1" "contains '$2'" "$3";; esac; }

q() { $PSQL -c "$1" | tr -d '\r'; }

login() {
  curl -s -o /dev/null -c "$COOKIE" -X POST "$API/api/auth/login" \
    -H 'Content-Type: application/json' -H 'Origin: http://localhost:8080' \
    -d '{"email":"dev@jarvis.local","password":"dev-password-1234"}'
}

say() {
  curl -s -b "$COOKIE" -X POST "$API/api/conversations/$CONV/messages" \
    -H 'Content-Type: application/json' -H 'Origin: http://localhost:8080' \
    -d "$(printf '%s' "$1" | python -c 'import json,sys;print(json.dumps({"body":sys.stdin.read()}))')"
}

# Everything about the most recent inbox event.
last() { q "SELECT COALESCE($1::text,'') FROM inbox_events ORDER BY received_at DESC, id LIMIT 1;"; }
segs() { q "SELECT COALESCE(jsonb_array_length(route_segments),-1) FROM inbox_events ORDER BY received_at DESC, id LIMIT 1;"; }
seg()  { q "SELECT COALESCE(route_segments->$1->>'$2','') FROM inbox_events ORDER BY received_at DESC, id LIMIT 1;"; }

login
CONV=$(q "SELECT id FROM conversations WHERE project_id IS NULL ORDER BY created_at LIMIT 1;")
echo "conversation: $CONV"

route_case() {
  local label="$1" msg="$2" expect="$3"
  echo
  echo "=== $label ==="
  say "$msg" >/dev/null
  local cat; cat=$(last route_category)
  local decided; decided=$(last route_decided_at)
  echo "  category=$cat segments=$(segs) reason=$(last routing_note)"
  check "$label -> $expect" "$expect" "$cat"
  if [ -n "$decided" ]; then ok "$label decision timestamped"; else bad "$label decision timestamped" "a timestamp" "(null)"; fi
}

route_case "capture"     "Remember the client prefers Tuesdays"        "capture"
route_case "work"        "In Alpha Web the login button is dead"       "work"
route_case "instruction" "From now on always ask me before deploying"  "instruction"
route_case "question"    "Remind me how does our deploy work"          "question"

echo
echo "=== the five-minute memo: one message, three destinations ==="
say "Quick brain dump: alpha web needs the checkout page fixed, also for alpha mobile I thought of a nicer onboarding, oh and next month we should review pricing" >/dev/null
INBOX=$(q "SELECT id FROM inbox_events ORDER BY received_at DESC, id LIMIT 1;")
echo "  inbox=$INBOX category=$(last route_category) segments=$(segs)"
check "the verdict is mixed, not one category" "mixed" "$(last route_category)"
check "three segments, not one" "3" "$(segs)"
check "segment 0 is work on alpha-web"    "work|alpha-web"    "$(seg 0 category)|$(seg 0 project)"
check "segment 1 is work on alpha-mobile" "work|alpha-mobile" "$(seg 1 category)|$(seg 1 project)"
check "segment 2 is a capture with no project" "capture|" "$(seg 2 category)|$(seg 2 project)"
contains "the work segments carry an objective" "Reproduce it" "$(seg 0 objective)"
check "the source text is still on the event, whole" "1" \
  "$(q "SELECT count(*) FROM inbox_events WHERE id = '$INBOX' AND raw_text LIKE 'Quick brain dump%review pricing';")"
check "and it is one event, not three" "1" \
  "$(q "SELECT count(*) FROM inbox_events WHERE raw_text LIKE 'Quick brain dump%';")"

echo
echo "=== a project that does not exist is asked about, not invented ==="
before=$(q "SELECT count(*) FROM projects;")
say "Please get that sorted in Zeppelin" >/dev/null
check "verdict is ambiguous" "ambiguous" "$(last route_category)"
check "no project was invented" "$before" "$(q 'SELECT count(*) FROM projects;')"
contains "the reason names what he said" "zeppelin" "$(seg 0 reason)"

echo
echo "=== a fenced JSON reply is still understood ==="
say "Give me a fenced reply please" >/dev/null
check "verdict parsed through the fence" "capture" "$(last route_category)"

echo
echo "=== prose instead of JSON fails closed, it does not become work ==="
say "This is a garbled router reply case" >/dev/null
check "verdict is ambiguous" "ambiguous" "$(last route_category)"
check "one segment, not zero" "1" "$(segs)"
contains "and it says why" "did not return usable segments" "$(seg 0 reason)"

echo
echo "=== a category the schema does not have is not trusted ==="
say "Try an invented category on this" >/dev/null
check "verdict is ambiguous" "ambiguous" "$(last route_category)"
check "the invented category did not survive" "ambiguous" "$(seg 0 category)"

echo
echo "=== an unroutable message is still stored and still answered ==="
before=$(q "SELECT count(*) FROM inbox_events;")
reply=$(say "Nothing in the router script matches this sentence at all")
echo "  reply=$reply"
check "the event was persisted anyway" "$((before+1))" "$(q 'SELECT count(*) FROM inbox_events;')"
check "verdict is ambiguous, never null" "ambiguous" "$(last route_category)"
contains "the router said it was unavailable" "no model route answered" "$(last routing_note)"
check "the message reached processed" "processed" "$(last processing_state)"
contains "and the turn still replied" "assistant" "$reply"

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

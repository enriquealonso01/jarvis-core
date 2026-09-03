#!/usr/bin/env bash
#
# S30 — asking a question of the live box, over HTTPS, as a browser would.
#
# The dev suites prove the retrieval logic. This proves the thing that logic is
# for is actually reachable: the migration applied, the route is registered, the
# answer carries citations, and an unanswerable question comes back as an
# honest no rather than as an empty success a caller would render as silence.
#
# Deliberately live: every layer between the query and the answer - Caddy, the
# API container, the session cookie, the migration - has failed at least once in
# this project while every unit test stayed green.
set -uo pipefail
HOST="${JARVIS_HOST:-jarvis-netcup}"
BASE="${JARVIS_URL:-https://jarvis.enriquecodes.com}"
pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }

echo "=== the schema arrived on the box ==="
cols=$(ssh "$HOST" "sudo docker exec jarvis-postgres-1 psql -U jarvis -d jarvis -tAc \
  \"SELECT count(*) FROM information_schema.columns WHERE table_name='knowledge_chunks' AND column_name IN ('search','locator','char_offset','source_date','kind')\"" | tr -d '\r')
if [ "$cols" = "5" ]; then ok "all five retrieval columns exist"; else bad "only $cols of 5 retrieval columns"; fi

idx=$(ssh "$HOST" "sudo docker exec jarvis-postgres-1 psql -U jarvis -d jarvis -tAc \
  \"SELECT count(*) FROM pg_indexes WHERE tablename='knowledge_chunks' AND indexname='knowledge_chunks_search_idx'\"" | tr -d '\r')
if [ "$idx" = "1" ]; then ok "and the GIN index is there, so ranking is not a sequential scan"; else bad "no GIN index"; fi

echo "=== the route is registered and refuses anonymous callers ==="
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/ask?q=refund")
case "$code" in
  401|403) ok "an unauthenticated ask is refused ($code)" ;;
  404) bad "the route is not registered (404) - the deploy did not carry it" ;;
  200) bad "an unauthenticated caller got an answer, which is a leak" ;;
  *) bad "unexpected status $code" ;;
esac

echo "=== it answers from inside the box, with citations ==="
# Run against the API container directly: this asserts the retrieval path, not
# the session layer, which s15 already covers.
out=$(ssh "$HOST" "cd /opt/jarvis/core && sudo -u jarvis bash -c 'set -a; . /etc/jarvis/runner.env; set +a; node --import tsx scripts/_ask_probe.ts'" 2>&1 | tr -d '\r')
echo "$out" | sed 's/^/    /'
case "$out" in
  *"known=true"*) ok "a question with an answer in the corpus is answered" ;;
  *) bad "the seeded question was not answered" ;;
esac
case "$out" in
  *"citation="*) ok "and the answer carries a citation" ;;
  *) bad "no citation came back" ;;
esac
case "$out" in
  *"unanswerable known=false"*) ok "a question with no answer is an honest no" ;;
  *) bad "an unanswerable question did not come back as known=false" ;;
esac

echo ""
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

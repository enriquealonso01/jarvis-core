#!/usr/bin/env bash
# Reproduce the intermittent burst loss in isolation.
#
# The plan requires "three messages in ten seconds -> three tasks, none merged,
# none dropped". S2's suite fails that roughly one run in ten, which is far too
# slow to debug through the whole suite. This fires the burst on its own, many
# times, and dumps the full picture the moment a task goes missing.
#
#   bash scripts/burst-repro.sh [rounds] [messages-per-round]
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
COOKIE=/tmp/burst-cookie.txt
ROUNDS="${1:-15}"
N="${2:-3}"

q() { $PSQL -c "$1" | tr -d '\r'; }

curl -s -o /dev/null -c "$COOKIE" -X POST "$API/api/auth/login" \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:8080' \
  -d '{"email":"dev@jarvis.local","password":"dev-password-1234"}'
CONV=$(q "SELECT id FROM conversations WHERE project_id IS NULL ORDER BY created_at LIMIT 1;")

say() {
  curl -s -b "$COOKIE" -X POST "$API/api/conversations/$CONV/messages" \
    -H 'Content-Type: application/json' -H 'Origin: http://localhost:8080' \
    -d "$(printf '{"body":"%s"}' "$1")"
}

fails=0
for r in $(seq 1 "$ROUNDS"); do
  q "DELETE FROM task_context; DELETE FROM task_events; DELETE FROM task_transitions;
     DELETE FROM task_attempts; DELETE FROM tasks WHERE title LIKE 'Burst %';" >/dev/null
  before=$(q "SELECT count(*) FROM tasks WHERE title LIKE 'Burst %';")
  for i in $(seq 1 "$N"); do
    case $i in 1) m="burst one";; 2) m="burst two";; 3) m="burst three";; esac
    say "$m" >/tmp/burst-reply-$i.txt &
  done
  wait
  sleep 1
  got=$(q "SELECT count(DISTINCT title) FROM tasks WHERE title LIKE 'Burst %';")
  if [ "$got" = "$N" ]; then
    echo "round $r: $got/$N ok"
  else
    fails=$((fails+1))
    echo "round $r: $got/$N  *** LOST ONE ***"
    echo "  --- replies ---"
    for i in $(seq 1 "$N"); do echo "    $i: $(head -c 200 /tmp/burst-reply-$i.txt)"; done
    echo "  --- inbox events ---"
    q "SELECT left(raw_text,16)||' | '||COALESCE(route_category,'-')||' | '||processing_state||' | '||COALESCE(routing_note,'-')
       FROM inbox_events WHERE raw_text ILIKE 'burst%' ORDER BY received_at;" | sed 's/^/    /'
    echo "  --- tasks ---"
    q "SELECT title FROM tasks WHERE title LIKE 'Burst %' ORDER BY created_at;" | sed 's/^/    /'
    echo "  --- api log tail ---"
    $COMPOSE logs api --tail 40 2>&1 | grep -iE "error|conflict|duplicate|deadlock|rollback" | tail -8 | sed 's/^/    /'
    break
  fi
done
echo "==== $fails failure(s) in $ROUNDS rounds ===="

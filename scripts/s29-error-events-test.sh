#!/usr/bin/env bash
#
# The runner writes a run's failures down.
#
# Driven through the REAL runner with a fake stream, because that is the only
# part of this that could not be verified any other way: on seven live parity
# runs neither vendor emitted an error item, so the persistence was deployed and
# never observed. A fake harness that fails one tool call costs nothing and
# exercises the same code path a real failure would.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f deploy/compose.dev.yaml"
PSQL="$COMPOSE exec -T postgres psql -U jarvis -d jarvis -tAX"
pass=0; fail=0
ok()   { echo "  ok   - $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL - $1"; echo "        expected: $2"; echo "        actual:   $3"; fail=$((fail+1)); }
q()    { $PSQL -c "$1" | tr -d '\r'; }

q "UPDATE tasks SET state='cancelled', lease_owner=NULL, lease_until=NULL
   WHERE lane='heavy' AND state IN ('queued','preparing','running');" >/dev/null

# The project must be allowed an engine, or the task parks at the ladder and the
# harness never runs - which reads as "no events were recorded" and is really
# "nothing ever executed". S12b made the per-project allowlist fail closed and
# fixtures written before that all hit this.
q "INSERT INTO auth_profile_allowlists (auth_profile_id, project_id, allowed_roles)
   SELECT 'anthropic_personal', id, ARRAY['senior_engineer'] FROM projects WHERE slug='alpha-web'
   ON CONFLICT (auth_profile_id, project_id) DO NOTHING;" >/dev/null

T=$(q "INSERT INTO tasks (project_id, lane, title, objective, state, priority)
       SELECT id, 'heavy', 's29 error events', 'x', 'queued', 'normal'
       FROM projects WHERE slug='alpha-web' RETURNING id;" | grep -oiE '^[0-9a-f-]{36}$' | head -1)
if [ -z "$T" ]; then echo "  FAIL  could not create the task"; echo "==== 0 passed, 1 failed ===="; exit 1; fi

$COMPOSE run --rm --no-deps -T -e RUNNER_ONCE=1 -e RUNNER_IDLE_EXIT_MS=8000 \
  -e JARVIS_HARNESS=fake:errortool -e JARVIS_HEARTBEAT_MS=1500 \
  runner >/tmp/s29err.log 2>&1

echo "1. the failed tool is recorded as an error event"
ERRS=$(q "SELECT count(*) FROM task_events WHERE task_id='$T' AND type='error';")
[ "$ERRS" = "1" ] && ok "one error event" || bad "one error event" "1" "$ERRS"

echo "2. it carries what actually failed"
MSG=$(q "SELECT coalesce(summary,'') FROM task_events WHERE task_id='$T' AND type='error' LIMIT 1;")
case "$MSG" in
  *"command not found"*) ok "summary: $MSG";;
  *) bad "the failing command's text" "contains 'command not found'" "$MSG";;
esac

echo "3. the successful tool call is still recorded too"
# Otherwise "record failures" could be satisfied by recording only failures.
TOOLS=$(q "SELECT count(*) FROM task_events WHERE task_id='$T' AND type='tool';")
[ "${TOOLS:-0}" -ge 1 ] && ok "$TOOLS tool event(s)" || bad "tool events" ">=1" "$TOOLS"

q "DELETE FROM task_checkpoints WHERE task_id='$T';" >/dev/null
q "UPDATE artifacts SET task_id=NULL WHERE task_id='$T';" >/dev/null
q "DELETE FROM task_events WHERE task_id='$T';" >/dev/null
q "DELETE FROM task_transitions WHERE task_id='$T';" >/dev/null
q "DELETE FROM task_attempts WHERE task_id='$T';" >/dev/null
q "DELETE FROM issues WHERE task_id='$T';" >/dev/null
q "DELETE FROM tasks WHERE id='$T';" >/dev/null

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

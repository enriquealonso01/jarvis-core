#!/usr/bin/env bash
# S25 — quota is a routable resource.
#
# Two halves. The routing decision is asserted by the TypeScript suite; the half
# below is the Done-when itself: "a coding task whose primary subscription is
# exhausted completes on the next engine without Enrique being told anything."
# That needs real runner containers, and a suite running inside one cannot start
# another — so it lives here.
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

STAMP=$(date +%s)
P1="s25run_one_$STAMP"
P2="s25run_two_$STAMP"
SLUG="s25-run-$STAMP"

cleanup() {
  q "DELETE FROM model_registry WHERE provider='s25run' AND model_id LIKE '%$STAMP%';" >/dev/null
  q "DELETE FROM auth_profile_allowlists WHERE auth_profile_id IN ('$P1','$P2');" >/dev/null
  q "DELETE FROM quota_observations WHERE auth_profile_id IN ('$P1','$P2');" >/dev/null
  q "UPDATE tasks SET auth_profile_id=NULL WHERE auth_profile_id IN ('$P1','$P2');" >/dev/null
  q "DELETE FROM auth_profiles WHERE id IN ('$P1','$P2');" >/dev/null
  # Children before parents, and the child list is every table with a foreign
  # key to tasks (`SELECT conname FROM pg_constraint WHERE confrelid =
  # 'tasks'::regclass`), not the two that came to mind. The first version
  # deleted tasks while task_transitions still pointed at them, so the whole
  # cleanup aborted on the first foreign key and left the project, its tasks and
  # its profiles behind for the next run to trip over.
  q "DELETE FROM task_transitions WHERE task_id IN
       (SELECT id FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE slug='$SLUG'));" >/dev/null
  q "DELETE FROM task_events WHERE task_id IN
       (SELECT id FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE slug='$SLUG'));" >/dev/null
  q "DELETE FROM task_attempts WHERE task_id IN
       (SELECT id FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE slug='$SLUG'));" >/dev/null
  q "DELETE FROM task_checkpoints WHERE task_id IN
       (SELECT id FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE slug='$SLUG'));" >/dev/null
  for t in task_context artifacts outbound_calls schedule_runs; do
    q "DELETE FROM $t WHERE task_id IN
         (SELECT id FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE slug='$SLUG'));" >/dev/null
  done
  q "UPDATE call_turns SET handover_task_id = NULL WHERE handover_task_id IN
       (SELECT id FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE slug='$SLUG'));" >/dev/null
  # tasks and issues point at each other (`tasks.blocked_by_issue_id`), so one of
  # the two links has to be cut before either row can go.
  q "UPDATE tasks SET blocked_by_issue_id = NULL WHERE project_id IN
       (SELECT id FROM projects WHERE slug='$SLUG');" >/dev/null
  # One statement, so the set of issues being deleted and the set whose action
  # requests are removed cannot differ. Two statements with the same WHERE
  # clause looked equivalent and were not: anything that appeared between them
  # blocked the second.
  q "WITH doomed AS (
       SELECT id FROM issues
        WHERE project_id IN (SELECT id FROM projects WHERE slug='$SLUG')
           OR task_id IN (SELECT id FROM tasks WHERE project_id IN
                (SELECT id FROM projects WHERE slug='$SLUG'))),
          gone AS (DELETE FROM user_action_requests WHERE issue_id IN (SELECT id FROM doomed))
     DELETE FROM issues WHERE id IN (SELECT id FROM doomed);" >/dev/null
  q "DELETE FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE slug='$SLUG');" >/dev/null
  q "DELETE FROM activity_events WHERE project_id IN (SELECT id FROM projects WHERE slug='$SLUG');" >/dev/null
  q "DELETE FROM auth_profile_allowlists WHERE project_id IN (SELECT id FROM projects WHERE slug='$SLUG');" >/dev/null
  q "DELETE FROM projects WHERE slug='$SLUG';" >/dev/null
}
trap cleanup EXIT

echo "########## S25 routing decisions ##########"
$COMPOSE run --rm --no-deps -T runner node --import tsx scripts/s25-routing-test.ts
ts=$?
if [ "$ts" -eq 0 ]; then ok "the routing suite passed"; else bad "the routing suite" "exit 0" "exit $ts"; fi

echo
echo "########## a coding task whose engine is spent finishes on the next one ##########"

# Two engines that the fake harness can stand in for, both logged in, both
# allowlisted for one project. The harness auth dir must exist or the runner is
# right to refuse; /tmp is inside the container and is enough for the fake.
q "INSERT INTO auth_profiles (id, provider, display_name, owner, billing_owner, auth_type,
                              confidentiality_eligibility, harness_auth_dir, health)
   VALUES ('$P1','s25run','S25 Run One','Enrique','Enrique','subscription_login',
           ARRAY['normal'],'/tmp/$P1','healthy'),
          ('$P2','s25run','S25 Run Two','Enrique','Enrique','subscription_login',
           ARRAY['normal'],'/tmp/$P2','healthy')
   ON CONFLICT (id) DO NOTHING;" >/dev/null

PROJ=$(q "INSERT INTO projects (slug,name,project_type,confidentiality)
          VALUES ('$SLUG','S25 run','personal','normal') RETURNING id;" | head -1)

q "INSERT INTO auth_profile_allowlists (auth_profile_id, project_id, allowed_roles)
   VALUES ('$P1','$PROJ',ARRAY['senior_engineer']),('$P2','$PROJ',ARRAY['senior_engineer'])
   ON CONFLICT DO NOTHING;" >/dev/null

q "INSERT INTO model_registry (provider, model_id, role_assignments, health, approval_state,
                               route_order, auth_profile_id, harness)
   VALUES ('s25run','one-$STAMP',ARRAY['senior_engineer'],'healthy','approved',1,'$P1','claude_code'),
          ('s25run','two-$STAMP',ARRAY['senior_engineer'],'healthy','approved',2,'$P2','claude_code');" >/dev/null

# Nothing else may claim this task, or the run under test never happens.
q "UPDATE tasks SET state='cancelled', lease_owner=NULL, lease_until=NULL
   WHERE lane='heavy' AND state IN ('queued','preparing','running');" >/dev/null

# The seeded anthropic route would otherwise sort ahead of these two.
q "UPDATE model_registry SET route_order = 500
   WHERE provider IN ('anthropic','openai_codex','cursor') AND 'senior_engineer' = ANY(role_assignments);" >/dev/null

TASK=$(q "INSERT INTO tasks (project_id,title,objective,state,lane,priority)
          VALUES ('$PROJ','S25 spent engine','finish on the next engine','queued','heavy','normal')
          RETURNING id;" | grep -oiE '^[0-9a-f-]{36}$' | head -1)
echo "  task $TASK"

ISSUES_BEFORE=$(q "SELECT count(*) FROM issues WHERE created_at > now() - interval '1 minute';")

# Run 1: the primary reports its subscription limit.
$COMPOSE run --rm --no-deps -T -e RUNNER_ONCE=1 -e RUNNER_IDLE_EXIT_MS=8000 \
  -e JARVIS_HARNESS=fake:fail -e JARVIS_FAKE_FAILURE=limit -e JARVIS_HEARTBEAT_MS=1500 \
  runner >/tmp/s25-run1.log 2>&1

STATE1=$(q "SELECT state FROM tasks WHERE id='$TASK';")
REASON1=$(q "SELECT COALESCE(waiting_reason,'') FROM tasks WHERE id='$TASK';")
QUOTA1=$(q "SELECT COALESCE(quota_json->>'status','-') FROM auth_profiles WHERE id='$P1';")
echo "  after run 1: state=$STATE1 quota($P1)=$QUOTA1"
echo "  reason: $REASON1"

check "the spent engine is marked, not the task" "exhausted" "$QUOTA1"
check "the task went back on the queue instead of parking" "queued" "$STATE1"
contains "and it says which engine it is moving to" "$P2" "$REASON1"
check "the lease was released" "" "$(q "SELECT COALESCE(lease_owner,'') FROM tasks WHERE id='$TASK';")"

ISSUES_AFTER=$(q "SELECT count(*) FROM issues WHERE created_at > now() - interval '1 minute';")
check "Enrique was told nothing" "$ISSUES_BEFORE" "$ISSUES_AFTER"

# Run 2: nothing wrong with the second engine.
$COMPOSE run --rm --no-deps -T -e RUNNER_ONCE=1 -e RUNNER_IDLE_EXIT_MS=8000 \
  -e JARVIS_HARNESS=fake -e JARVIS_HEARTBEAT_MS=1500 \
  runner >/tmp/s25-run2.log 2>&1

STATE2=$(q "SELECT state FROM tasks WHERE id='$TASK';")
RAN_ON=$(q "SELECT COALESCE(auth_profile_id,'-') FROM tasks WHERE id='$TASK';")
ATTEMPTS=$(q "SELECT count(*) FROM task_attempts WHERE task_id='$TASK';")
echo "  after run 2: state=$STATE2 ran_on=$RAN_ON attempts=$ATTEMPTS"

check "it ran on the next engine" "$P2" "$RAN_ON"
check "two attempts, one per engine" "2" "$ATTEMPTS"
case "$STATE2" in
  queued|preparing|running|recovering|failed_terminal|waiting_for_provider)
    bad "the task got through the run" "a state past running" "$STATE2";;
  *) ok "the task got through the run (state $STATE2)";;
esac
check "the second engine is recorded as having served" "healthy" \
  "$(q "SELECT COALESCE(quota_json->>'status','-') FROM auth_profiles WHERE id='$P2';")"

echo
echo "########## a task that NAMES an engine is never moved off it ##########"
q "UPDATE tasks SET state='cancelled' WHERE id='$TASK';" >/dev/null
PIN=$(q "INSERT INTO tasks (project_id,title,objective,state,lane,priority,auth_profile_id)
         VALUES ('$PROJ','S25 pinned','stay put','queued','heavy','normal','$P1')
         RETURNING id;" | grep -oiE '^[0-9a-f-]{36}$' | head -1)
$COMPOSE run --rm --no-deps -T -e RUNNER_ONCE=1 -e RUNNER_IDLE_EXIT_MS=8000 \
  -e JARVIS_HARNESS=fake:fail -e JARVIS_FAKE_FAILURE=limit -e JARVIS_HEARTBEAT_MS=1500 \
  runner >/tmp/s25-run3.log 2>&1
check "a pinned task stays on its own profile" "$P1" \
  "$(q "SELECT COALESCE(auth_profile_id,'-') FROM tasks WHERE id='$PIN';")"
check "and parks rather than being silently rehomed" "waiting_for_provider" \
  "$(q "SELECT state FROM tasks WHERE id='$PIN';")"

# Put the seeded routes back where they were.
q "UPDATE model_registry SET route_order = 5 WHERE provider='anthropic' AND model_id='claude-sonnet-host';" >/dev/null
q "UPDATE model_registry SET route_order = 15 WHERE provider='openai_codex' AND model_id='codex-host';" >/dev/null
q "UPDATE model_registry SET route_order = 20 WHERE provider='cursor' AND model_id='cursor-acp-host';" >/dev/null

echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

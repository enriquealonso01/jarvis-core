#!/usr/bin/env bash
# S12 — isolation, proved.
#
# Two halves. This one is the filesystem: a task running in Alpha reaches for
# Beta's repository and for Beta's browser profile, the two probes in L9 that
# cannot be made over HTTP because they are a `cat` inside a harness run.
#
# The probe is made the way a real harness would make it — a Bash command with
# an absolute path in it — so it exercises the command scanner rather than the
# tidy path-argument case. Two independent layers are asked about separately,
# because they answer differently and only one of them is currently a wall:
#
#   1. Does the runner SEE it and kill the run? (assert: yes, every time)
#   2. Does the filesystem STOP it?             (assert: whatever is true, and
#      say so — for a personal project the runner and the worktrees are the same
#      unix user by design; ADR 006 step 5 allocates a dedicated uid only for
#      professional and confidential projects, and that is not built.)
#
# Then it hands over to the HTTP half, scripts/s12-isolation-test.ts.
set -uo pipefail
cd "$(dirname "$0")/.."

# Git Bash on Windows rewrites anything that looks like a unix path in an
# argument into a Windows path. `-e JARVIS_PROBE_PATH=/var/lib/jarvis/...`
# reached the container as `C:/Program Files/Git/var/lib/jarvis/...`, so the
# probe asked for a path that does not exist, the runner correctly did not flag
# it, and the suite read that as "the guard is broken". A test that can be
# defeated by the shell it runs in is not testing the thing it names.
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
ALPHA="s12fs-alpha-$STAMP"
BETA="s12fs-beta-$STAMP"

# Each probe must be the only thing the one-shot runner can claim.
clearqueue() {
  q "UPDATE tasks SET state='cancelled', lease_owner=NULL, lease_until=NULL
     WHERE lane='heavy' AND state IN ('queued','preparing','running');" >/dev/null
}

echo "########## L9 — the two filesystem probes ##########"
echo

q "INSERT INTO projects (slug,name,project_type,confidentiality,production_status)
   VALUES ('$ALPHA','$ALPHA','personal','normal','non_production'),
          ('$BETA','$BETA','professional','confidential','non_production')
   ON CONFLICT (slug) DO NOTHING;" >/dev/null

# Alpha must be allowed an engine, or nothing runs and every probe below reads
# as "the guard did not fire" when the truth is that the harness never started.
#
# S12b made the per-project allowlist fail closed, and this fixture was written
# before that: it creates Alpha fresh on every run with no allowlist row, so the
# ladder refused every route and the task parked at waiting_for_provider. Eleven
# assertions then failed for a reason that had nothing to do with isolation. The
# S28 parity fixture hit this exact wall and says so in its own comment.
q "INSERT INTO auth_profile_allowlists (auth_profile_id, project_id, allowed_roles)
   SELECT 'anthropic_personal', id, ARRAY['senior_engineer'] FROM projects WHERE slug='$ALPHA'
   ON CONFLICT (auth_profile_id, project_id) DO NOTHING;" >/dev/null

# Beta's belongings, put where Beta's belongings live.
BETA_FILE="/var/lib/jarvis/projects/$BETA/repo/.env"
BETA_COOKIES="/var/lib/jarvis/browsers/$BETA/Default/Cookies"
$COMPOSE run --rm --no-deps -T runner sh -c "
  mkdir -p /var/lib/jarvis/projects/$BETA/repo /var/lib/jarvis/browsers/$BETA/Default &&
  printf 'STRIPE_KEY=beta-only-$STAMP\n' > $BETA_FILE &&
  printf 'session=beta-logged-in-$STAMP\n' > $BETA_COOKIES" >/dev/null 2>&1

newtask() {
  clearqueue
  q "INSERT INTO tasks (project_id,title,objective,state,lane,priority)
     SELECT id,'$1','x','queued','heavy','normal' FROM projects WHERE slug='$ALPHA'
     RETURNING id;" | grep -oiE '^[0-9a-f-]{36}$' | head -1
}

probe() {
  local label="$1" target="$2"
  echo "=== $label ==="
  # The title goes into SQL by string interpolation, so an apostrophe in the
  # label ends the literal and the INSERT returns nothing — which reads as
  # "the runner did not classify it" rather than as a broken test.
  local title; title=$(printf '%s' "$label" | tr -d "'")
  local t; t=$(newtask "S12 probe $title")
  $COMPOSE run --rm --no-deps -T -e RUNNER_ONCE=1 -e RUNNER_IDLE_EXIT_MS=8000 \
    -e JARVIS_HARNESS=fake:probe -e JARVIS_PROBE_PATH="$target" \
    -e JARVIS_HEARTBEAT_MS=1500 runner >/tmp/s12probe.log 2>&1

  local cls state audits issues
  cls=$(q "SELECT COALESCE(error_class,'-') FROM task_attempts WHERE task_id='$t' ORDER BY n DESC LIMIT 1;")
  state=$(q "SELECT state FROM tasks WHERE id='$t';")
  audits=$(q "SELECT count(*) FROM audit_events WHERE action='harness.escape_blocked' AND target='$target';")
  issues=$(q "SELECT count(*) FROM issues WHERE task_id='$t' AND category='security.isolation';")

  check "the runner saw the cross-project read" "security.isolation" "$cls"
  check "and stopped the run" "failed_terminal" "$state"
  check "the attempted path is audited, named" "1" "$audits"
  check "and it raised an isolation Issue" "1" "$issues"
  contains "the summary says what was reached for" "$target" \
    "$(q "SELECT COALESCE(summary,'') FROM task_attempts WHERE task_id='$t' ORDER BY n DESC LIMIT 1;")"

  # Layer 2, reported honestly. The fake harness prints which one it got.
  if grep -q "probe read=DENIED" /tmp/s12probe.log; then
    ok "and the filesystem refused the read as well"
  else
    echo "  NOTE  the filesystem did NOT refuse the read: same unix user."
    echo "        Detection stopped the run; containment did not exist. ADR 006"
    echo "        step 5 (per-project uid) is unbuilt — see BLOCKED.md."
  fi
  echo
}

probe "Beta's repository files" "$BETA_FILE"
probe "Beta's browser profile" "$BETA_COOKIES"

# The negative: a task reading its OWN worktree is not an escape. Without this
# the assertions above pass just as well on a guard that flags everything, which
# is the guard that gets switched off in week two.
echo "=== a task reading its own workspace is not an escape ==="
T=$(newtask "S12 control")
SHORT=$(echo "$T" | cut -c1-8)
$COMPOSE run --rm --no-deps -T -e RUNNER_ONCE=1 -e RUNNER_IDLE_EXIT_MS=8000 \
  -e JARVIS_HARNESS=fake:probe \
  -e JARVIS_PROBE_PATH="/var/lib/jarvis/worktrees/$ALPHA/$SHORT/README.md" \
  -e JARVIS_HEARTBEAT_MS=1500 runner >/tmp/s12control.log 2>&1
check "not classified as an isolation breach" "-" \
  "$(q "SELECT COALESCE(error_class,'-') FROM task_attempts WHERE task_id='$T' ORDER BY n DESC LIMIT 1;")"
check "and no escape was audited for it" "0" \
  "$(q "SELECT count(*) FROM audit_events WHERE action='harness.escape_blocked'
        AND metadata->>'task_id'='$T';")"

echo
echo "########## the HTTP half ##########"
echo
$COMPOSE run --rm --no-deps -T runner node --import tsx scripts/s12-isolation-test.ts 2>&1 \
  | sed '/^ *$/d' | tee /tmp/s12http.log
http=$?
hp=$(grep -oE '==== [0-9]+ passed, [0-9]+ failed ====' /tmp/s12http.log | grep -oE '^==== [0-9]+' | grep -oE '[0-9]+')
hf=$(grep -oE '[0-9]+ failed' /tmp/s12http.log | grep -oE '[0-9]+')
pass=$((pass + ${hp:-0}))
fail=$((fail + ${hf:-1}))

# Take the two filesystem-probe projects back out.
#
# The TypeScript half of this suite tears down its own fixtures; this wrapper
# creates two more with psql directly and never removed them. 25 of each had
# accumulated. That is not inert: Stage B's rule 4 correlates a message to the
# same sender and channel inside ten minutes, so a leftover project's thread
# becomes an attractor that later messages join - which is exactly how
# s37-untrusted-test came to fail on three assertions about forwards.
#
# Through the reaper rather than a DELETE here, because a project has 29 tables
# pointing at it and one of those references has to be nulled rather than
# followed. That logic lives in _teardown.ts and should not be written twice.
$COMPOSE run --rm --no-deps -T runner   node --import tsx scripts/reap-fixture-projects.ts "s12fs-alpha-%" "s12fs-beta-%"   >/dev/null 2>&1 || echo "warning: could not reap the s12fs fixtures" >&2


echo
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

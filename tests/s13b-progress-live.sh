#!/usr/bin/env bash
#
# S13b: the build bar reflects the box, and a code deploy cannot revert it.
#
# Four assertions, all against the live site over HTTPS - the browser path, not
# an internal one, because the bar being right for curl and wrong for Enrique is
# the failure that keeps happening:
#
#   1. /PROGRESS.json is served as JSON and matches what was published.
#   2. /BLOCKED.md is served as the FILE, not the console SPA. The console links
#      to it from the blocked and awaiting counts, and a link that silently
#      returns the dashboard is a count with no way to read the reason.
#   3. Editing the published file changes what is served, with no restart and no
#      rebuild - that is the whole point of publishing being a copy.
#   4. Writing a DIFFERENT PROGRESS.json into the deploy tree - which is what
#      every code deploy does - does not change what is served.
#
# Assertion 4 is the regression. It fails against the old layout by construction.
set -uo pipefail

HOST="${JARVIS_HOST:-jarvis-netcup}"
URL=https://jarvis.enriquecodes.com
fails=0
ok()   { echo "  ok   - $1"; }
fail() { echo "  FAIL - $1"; fails=$((fails+1)); }

served_steps() { curl -s "$URL/PROGRESS.json?t=$RANDOM" | python -c "import json,sys; print(json.load(sys.stdin)['total_steps'])" 2>/dev/null || echo ERR; }

echo "1. what is served IS what is published"
# Not just "is it JSON": the 503 this route returns for a missing file is also
# application/json, so a content-type check alone goes green on an outage. The
# assertion is that the numbers on the bar are main numbers.
want=$(git show origin/main:PROGRESS.json | python -c "import json,sys; print(json.load(sys.stdin)['total_steps'])")
got=$(served_steps)
[ "$got" = "$want" ] && ok "total_steps $got matches origin/main" || fail "serving $got, main says $want"
has_working=$(curl -s "$URL/PROGRESS.json?t=$RANDOM" | python -c "import json,sys; print('yes' if json.load(sys.stdin).get('working_on') else 'no')" 2>/dev/null)
[ "$has_working" = "yes" ] && ok "working_on present" || fail "working_on missing - the bar cannot say what is being built"

echo "2. BLOCKED.md is the file, not the SPA"
# Asserted on the CONTENT, not merely on not-being-HTML. The first version of
# this check only excluded HTML, and passed against a Fastify 404 body -
# {"message":"Route GET:/BLOCKED.md not found"} - which is neither the file nor
# the SPA. A test that goes green on a 404 is worse than no test.
code=$(curl -s -o /tmp/blocked.$$ -w '%{http_code}' "$URL/BLOCKED.md")
body=$(head -c 2000 /tmp/blocked.$$); rm -f /tmp/blocked.$$
first=$(git show origin/main:BLOCKED.md | head -1)
if [ "$code" != "200" ]; then
  fail "http $code: $(echo "$body" | head -c 80)"
elif [ "${body#"$first"}" = "$body" ]; then
  fail "body does not start with the real file: $(echo "$body" | head -c 80)"
else
  ok "served the file itself ($first)"
fi

echo "3. a copy is enough - no restart, no rebuild"
before=$(served_steps)
started_before=$(ssh "$HOST" "sudo docker inspect jarvis-api-1 --format '{{.State.StartedAt}}'")
ssh "$HOST" "sudo python3 - <<'PY'
import json
p='/var/lib/jarvis/state/PROGRESS.json'
d=json.load(open(p)); d['total_steps']=4242
json.dump(d,open(p,'w'))
PY" >/dev/null 2>&1
after=$(served_steps)
[ "$after" = "4242" ] && ok "edit visible immediately (was $before)" || fail "edit not reflected: served $after"

echo "4. a code deploy does not revert the bar"
# Exactly what a deploy does: extract a branch copy over the deploy tree.
ssh "$HOST" "sudo python3 - <<'PY'
import json
p='/opt/jarvis/core/PROGRESS.json'
d=json.load(open(p)); d['total_steps']=9999
json.dump(d,open(p,'w'))
PY" >/dev/null 2>&1
still=$(served_steps)
[ "$still" = "4242" ] && ok "deploy tree write ignored (served $still)" || fail "code tree overwrote the served state: $still"

started_after=$(ssh "$HOST" "sudo docker inspect jarvis-api-1 --format '{{.State.StartedAt}}'")
[ "$started_before" = "$started_after" ] && ok "api never restarted" || fail "api restarted during the test"

echo "restoring published state"
bash "$(dirname "$0")/../scripts/publish-progress.sh" >/dev/null 2>&1

echo
[ "$fails" -eq 0 ] && echo "S13b PASS" || echo "S13b FAIL ($fails)"
exit "$fails"

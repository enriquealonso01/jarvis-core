#!/usr/bin/env bash
#
# The build bar publishes itself, and a bad publish never replaces a good file.
#
# Run against the live box. The failure this guards is specific: the publisher
# runs unattended on a timer now, so a malformed or truncated PROGRESS.json
# would be served to the console with nobody watching. Keeping yesterday's valid
# file and failing loudly is the only acceptable outcome.
set -uo pipefail
HOST="${JARVIS_HOST:-jarvis-netcup}"
CORE=/opt/jarvis/core
STATE=/var/lib/jarvis/state
pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }

echo "=== the timer exists and is running ==="
if ssh "$HOST" "systemctl is-active jarvis-progress-publish.timer" | grep -q '^active$'; then
  ok "jarvis-progress-publish.timer is active"
else
  bad "the timer is not active, so the bar is only as fresh as the last human"
fi

next=$(ssh "$HOST" "systemctl list-timers --no-pager jarvis-progress-publish.timer 2>/dev/null | grep -c progress")
if [ "$next" = "1" ]; then ok "and it is scheduled to fire again"; else bad "no future firing scheduled"; fi

echo "=== it publishes what main actually says ==="
steps=$(ssh "$HOST" "cd $CORE && sudo -u jarvis bash -c 'set -a; . /etc/jarvis/runner.env; set +a; node --import tsx scripts/publish-progress-pull.ts main'" 2>&1 | tail -1)
echo "    $steps"
case "$steps" in
  *"51 steps"*) ok "the published file carries the full step list" ;;
  *) bad "unexpected publish output: $steps" ;;
esac

served=$(curl -s https://jarvis.enriquecodes.com/PROGRESS.json | python -c "import json,sys; print(len(json.load(sys.stdin)['steps']))" 2>/dev/null)
if [ "$served" = "51" ]; then ok "and the console is served the same count ($served)"; else bad "the site served $served steps"; fi

echo "=== a publish that cannot parse leaves the good file alone ==="
before=$(ssh "$HOST" "sudo md5sum $STATE/PROGRESS.json | cut -d' ' -f1")
# The exit code, captured on the remote side: a local pipeline would report
# tail's status, which is always 0 and would pass no matter what happened.
out=$(ssh "$HOST" "cd $CORE && sudo -u jarvis bash -c 'set -a; . /etc/jarvis/runner.env; set +a; JARVIS_PROGRESS_FILE=BLOCKED.md node --import tsx scripts/publish-progress-pull.ts main'; echo EXIT=\$?" 2>&1 | tail -2 | tr -d '')
echo "    $(echo "$out" | head -1 | cut -c1-70)"
case "$out" in
  *EXIT=0*) bad "a publish of non-JSON reported success" ;;
  *EXIT=*) ok "publishing a file that is not JSON exits non-zero" ;;
  *) bad "no exit status came back: $out" ;;
esac
after=$(ssh "$HOST" "sudo md5sum $STATE/PROGRESS.json | cut -d' ' -f1")
if [ "$before" = "$after" ]; then
  ok "and the previously published file is untouched"
else
  bad "a failed publish overwrote the served file"
fi

echo ""
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

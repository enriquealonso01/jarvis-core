#!/usr/bin/env bash
# Run every suite, in order, and print one table.
#
# Two things make a sweep lie if they are not handled here, and both have cost
# real time:
#
#   1. A retryable failure leaves its task QUEUED. The next suite's one-shot
#      runner then claims the previous suite's leftover, its own task is never
#      started, and the failure reads as "the runner is broken" rather than as
#      interference. So the heavy queue is cleared between suites.
#   2. Git Bash rewrites unix-looking paths in arguments. Each suite guards
#      itself, but the sweep sets it too so a suite added later cannot be
#      caught by it before anyone notices.
#
# Exit status is the number of suites that failed, so CI can use it directly.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f deploy/compose.dev.yaml"

SUITES="s1-harness-test s2-task-create-test s3-routing-test s3b-split-test s3c-context-test
        s4-drain-test s4-recovery-test s6-workflow-test s9-review-test s10-grants-test
        s11-recovery-test s12-isolation-test s13-home-test s14-live-detail-test
        s15-console-test"

clearqueue() {
  $COMPOSE exec -T postgres psql -U jarvis -d jarvis -tAX -c \
    "UPDATE tasks SET state='cancelled', lease_owner=NULL, lease_until=NULL
     WHERE lane='heavy' AND state IN ('queued','preparing','running');" >/dev/null 2>&1
}

broken=0
results=""
for s in $SUITES; do
  clearqueue
  line=$(bash "scripts/$s.sh" 2>&1 | grep -oE '==== [0-9]+ passed, [0-9]+ failed ====' | tail -1)
  if [ -z "$line" ]; then
    results="$results\n  $s  NO SUMMARY — the suite did not finish"
    broken=$((broken+1))
    continue
  fi
  f=$(printf '%s' "$line" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+')
  p=$(printf '%s' "$line" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+')
  if [ "${f:-1}" -eq 0 ]; then
    results="$results\n  $s  $p passed"
  else
    results="$results\n  $s  $p passed, $f FAILED"
    broken=$((broken+1))
  fi
done

echo
echo "==================== sweep ===================="
printf '%b\n' "$results"
echo "==============================================="
echo "$broken suite(s) with failures"
exit "$broken"

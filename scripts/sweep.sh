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
        s11-recovery-test s12-isolation-test s12-privdrop-test s12b-router-test s12b-canary-test s12b-reauth-test s12b-audit-test s12c-live-faults-test s13-home-test s14-live-detail-test
        s15-console-test s16-credential-test s16b-deviceflow-test
        s17-artifacts-test s18-search-test s18b-retrofit-test s19-call-test
        s20-turntaking-test s21-runtime-test s21b-call-defects-test
        s22-desk-test s23-outbound-test s24-callreview-test
        s25-routing-test s28-runtime-test s28-park-test
        outbound-leg-test unscoped-heavy-test handover-scope-test
        harness-issue-test fixture-teardown-test confidential-eligibility-test
        s37-outbox-send pairing-notification-test
        s29-escalation-test s29-scoring-test"

# Suites deliberately NOT in the sweep, and why. Each needs something the sweep
# cannot give it, and a suite that cannot pass here would train everyone to
# ignore a red sweep:
#
#   s13b-progress-live      asserts against the live site over HTTPS
#   s37-voicenote-live      posts to the live API and spends Groq minutes
#   s37-ingest-live         same
#   s28-parity-live         creates a real GitHub repo and runs two harnesses
#   s22-live-call-to-pr     places a real call
#   s7-live-pr, s6-console-to-pr, s12c-live-faults  real credentials, real repos
#   tier1-latency-test      needs a real model route; it refuses to run without
#                           one rather than passing in 8ms on a missing provider
#   project-api-credential-test  needs github_personal_admin to copy from
#
# The line those all cross is the same one: they need production, money, or a
# credential the dev database does not have.

clearqueue() {
  $COMPOSE exec -T postgres psql -U jarvis -d jarvis -tAX -c \
    "UPDATE tasks SET state='cancelled', lease_owner=NULL, lease_until=NULL
     WHERE lane='heavy' AND state IN ('queued','preparing','running');" >/dev/null 2>&1
}

# A named subset runs on its own: `bash scripts/sweep.sh s18-search-test s19-call-test`.
# The whole sweep takes longer than some callers are willing to wait, and half a
# sweep run twice is worth more than a whole one that gets killed in the middle
# and leaves its runner containers behind.
if [ "$#" -gt 0 ]; then SUITES="$*"; fi

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

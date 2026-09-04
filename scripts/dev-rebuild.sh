#!/usr/bin/env bash
# Rebuild the dev images and REFUSE to continue if the build failed.
#
#   bash scripts/dev-rebuild.sh [service ...]     # default: api runner seed
#
# This exists because the same mistake has been made three times: a change (very
# often a deliberate sabotage during a see-it-fail pass) fails `tsc` inside the
# Docker build, `docker compose up --build` prints the error somewhere in a
# hundred lines of build log, the previous image keeps running, and the test
# suite then reports a confident green for code that was never deployed. A green
# result from a stale image is worse than a red one.
#
# So: typecheck on the host first, build with the output checked, and exit
# non-zero the moment either fails. Callers that use `&&` cannot then run a
# suite against an image that does not match the tree.
set -uo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f deploy/compose.dev.yaml"
SERVICES="${*:-api runner seed}"

echo "--- typecheck ---"
if ! npx tsc -p tsconfig.json --noEmit; then
  echo "REFUSING TO BUILD: the tree does not typecheck. The running image is unchanged." >&2
  exit 1
fi

echo "--- build: $SERVICES ---"
log=$(mktemp)
if ! JARVIS_MODEL=fake $COMPOSE build $SERVICES >"$log" 2>&1; then
  echo "BUILD FAILED. The running image is unchanged and any test result would be a lie." >&2
  tail -30 "$log" >&2
  rm -f "$log"
  exit 1
fi
# `docker compose build` has been known to exit 0 with an error in the log.
if grep -qiE '^#[0-9]+ ERROR|error TS[0-9]+' "$log"; then
  echo "BUILD REPORTED AN ERROR despite exiting 0:" >&2
  grep -iE '^#[0-9]+ ERROR|error TS[0-9]+' "$log" | head -20 >&2
  rm -f "$log"
  exit 1
fi
rm -f "$log"

case " $SERVICES " in
  *" api "*)
    JARVIS_MODEL=fake $COMPOSE up -d --no-build api >/dev/null 2>&1
    up=0
    for _ in $(seq 1 30); do
      # `>/dev/null` rather than curl's own `-o /dev/null`, and the difference
      # is not style. Under MSYS_NO_PATHCONV=1 — which sweep.sh exports, and
      # every suite with it — Git Bash stops rewriting /dev/null into a Windows
      # path, curl is handed a filename it cannot open, and it exits 23 on a
      # perfectly good 200. The old loop hid that (it just never broke early and
      # fell through to "running"); making the check strict without fixing this
      # would have failed every sweep on this platform. The redirection is the
      # shell's job, so it works either way.
      if curl -sf http://127.0.0.1:8080/api/health >/dev/null 2>&1; then up=1; break; fi
      sleep 1
    done
    # The health poll used to `break` on success and simply fall out of the loop
    # on failure, after which this script printed "rebuilt and running" and
    # exited 0 — over an API that was crash-looping. That is the same lie this
    # file was written to prevent, one layer along: a green result from a dead
    # API is worse than a red one, because every suite that follows fails for a
    # reason that has nothing to do with what it is testing.
    #
    # Found the hard way: a duplicate route registration crashed the API on
    # boot, this said "rebuilt and running", and the suite reported "fetch
    # failed" as though the assertion were at fault.
    if [ "$up" -ne 1 ]; then
      echo "THE API DID NOT COME UP. It is not serving /api/health after 30s." >&2
      $COMPOSE logs api --tail 20 2>&1 | tail -20 >&2
      exit 1
    fi
    ;;
esac

# The worker, and the same argument the API block above makes.
#
# dev-rebuild brought up the API and nothing else, so the worker was simply
# absent after any rebuild - and every suite that needs a task to progress
# (harness, drain, recovery) then failed for a reason that had nothing to do with
# what it was testing. Measured: s1-harness-test went 16 passed / 7 FAILED to
# 23 passed / 0 the moment the worker was started, with no code change at all.
#
# That is the same lie this file exists to prevent, one layer along: a suite red
# because a service is missing is worse than one red for a real reason, because
# it trains everyone to read failures as noise.
#
# Liveness is its watchdog sweep advancing, not the container existing. A worker
# that is up and wedged produces exactly the confusing failures above, and
# `docker ps` cannot tell the difference.
JARVIS_MODEL=fake $COMPOSE up -d --no-build worker >/dev/null 2>&1
# A RECENT sweep, not a fresh one. The watchdog sweeps about every 80 seconds, so
# demanding the counter advance means waiting most of a cycle even when the worker
# is perfectly healthy - the first version of this gate did exactly that and
# reported a working worker as broken.
worker_up=0
for _ in $(seq 1 100); do
  fresh=$($COMPOSE exec -T postgres psql -U jarvis -d jarvis -tAX -c     "SELECT 1 FROM component_sweeps
      WHERE component='watchdog' AND last_completed_at > now() - interval '3 minutes';"     2>/dev/null | tr -d '')
  if [ "$fresh" = "1" ]; then worker_up=1; break; fi
  sleep 2
done
if [ "$worker_up" -ne 1 ]; then
  echo "THE WORKER IS NOT SWEEPING. Suites that need a task to progress will fail" >&2
  echo "for a reason that has nothing to do with what they are testing." >&2
  $COMPOSE logs worker --tail 20 2>&1 | tail -20 >&2
  exit 1
fi

echo "rebuilt and running: $SERVICES (+ worker sweeping)"

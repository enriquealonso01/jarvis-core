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
      if curl -sf -o /dev/null http://127.0.0.1:8080/api/health; then up=1; break; fi
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
echo "rebuilt and running: $SERVICES"

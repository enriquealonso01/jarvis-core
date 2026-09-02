#!/usr/bin/env bash
# S23 — Jarvis calls Enrique: the six reasons, quiet hours, and the one override.
#
# Two passes, because the site file is chosen by an environment variable that is
# read once at import. The first runs against the full fixture; the second takes
# the telnyx pair away and checks the dial is refused rather than sent blank.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

rc=0

docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  -e JARVIS_TELNYX=fake \
  -e JARVIS_SITE_YAML=/app/scripts/fixtures/s19-site.yaml \
  runner node --import tsx scripts/s23-outbound-test.ts 2>&1
rc=$(( rc + $? ))

echo
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  -e JARVIS_TELNYX=fake \
  -e JARVIS_S23_NO_TELNYX=1 \
  -e JARVIS_SITE_YAML=/app/scripts/fixtures/s23-site-no-telnyx.yaml \
  runner node --import tsx scripts/s23-outbound-test.ts 2>&1
rc=$(( rc + $? ))

exit $rc

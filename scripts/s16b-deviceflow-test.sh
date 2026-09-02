#!/usr/bin/env bash
# The OAuth device flow (netcup SCP), offline. The provider itself is proved by
# scripts/s16b-deviceflow-live.ts, on the box, against the real endpoint.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
COMPOSE="docker compose -f deploy/compose.dev.yaml"

$COMPOSE run --rm --no-deps -T \
  -e JARVIS_DEVICEFLOW=fake \
  -e JARVIS_CONNTEST= \
  runner node --import tsx scripts/s16b-deviceflow-test.ts 2>&1

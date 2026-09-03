#!/usr/bin/env bash
# S31 — one check order, one audit shape, and an action set that is not a switch.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s31-connector-test.ts 2>&1

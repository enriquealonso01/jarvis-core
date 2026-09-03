#!/usr/bin/env bash
# S34 / L14 — overlap, misfire, failure pause, no duplicate fire.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s34-schedule-test.ts 2>&1

#!/usr/bin/env bash
# S53 — many agents on one goal, and the three governors.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s53-orchestration-test.ts 2>&1

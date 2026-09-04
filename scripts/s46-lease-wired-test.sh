#!/usr/bin/env bash
# S46, wired — leaving the running family releases the seat.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s46-lease-wired-test.ts 2>&1

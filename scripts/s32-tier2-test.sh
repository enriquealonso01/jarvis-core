#!/usr/bin/env bash
# S32 tier 2 — the rung that was declared and left unimplemented.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s32-tier2-test.ts 2>&1

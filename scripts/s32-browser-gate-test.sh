#!/usr/bin/env bash
# S32 — the click that must stop (Mode 1's gate).
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s32-browser-gate-test.ts 2>&1

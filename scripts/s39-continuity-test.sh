#!/usr/bin/env bash
# S39 — start by voice, add by WhatsApp, finish in the console.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s39-continuity-test.ts 2>&1

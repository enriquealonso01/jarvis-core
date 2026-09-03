#!/usr/bin/env bash
# S35 — the export gate, and the key that must not travel with it.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s35-export-test.ts 2>&1

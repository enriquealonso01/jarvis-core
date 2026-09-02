#!/usr/bin/env bash
# S12b item 6 — the canonical audit metadata keys (IV.9).
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s12b-audit-test.ts 2>&1

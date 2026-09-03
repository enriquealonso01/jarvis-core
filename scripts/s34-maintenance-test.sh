#!/usr/bin/env bash
# S34 — dump a document, fill the disk, run Maintenance, ask again.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s34-maintenance-test.ts 2>&1

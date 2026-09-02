#!/usr/bin/env bash
# S28 - a task pointed at a runtime that is not there parks, and says why.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T   runner node --import tsx scripts/s28-park-test.ts 2>&1

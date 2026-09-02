#!/usr/bin/env bash
# S28 - the runtime interface: two unrelated vendor streams, one shape.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s28-runtime-test.ts 2>&1

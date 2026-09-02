#!/usr/bin/env bash
# A fixture project cleans up after itself, including out of the queue.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/fixture-teardown-test.ts 2>&1

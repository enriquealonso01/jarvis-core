#!/usr/bin/env bash
# A gate that exists in three implementations is three gates, and one is wrong.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s31-connector-test.ts 2>&1

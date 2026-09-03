#!/usr/bin/env bash
# S31 — a plain API key on the same seam, making a real call.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm -T \
  runner node --import tsx scripts/s31-api-test.ts 2>&1

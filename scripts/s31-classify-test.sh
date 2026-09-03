#!/usr/bin/env bash
# S31 — a tool is inert until a person has said what it can reach.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s31-classify-test.ts 2>&1

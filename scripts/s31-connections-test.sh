#!/usr/bin/env bash
# S31 — the Connections tab, and a revoke asserted on the far side.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm -T \
  runner node --import tsx scripts/s31-connections-test.ts 2>&1

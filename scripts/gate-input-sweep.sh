#!/usr/bin/env bash
# One bug class across every gate that answers "may this happen".
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/gate-input-sweep.ts 2>&1

#!/usr/bin/env bash
# An answer that looks right and comes from the wrong place is the worst kind.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s30-which-tier-test.ts 2>&1

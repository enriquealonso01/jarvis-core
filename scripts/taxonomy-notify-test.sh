#!/usr/bin/env bash
# B10 — the three failure classes that were inheriting somebody else's policy.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/taxonomy-notify-test.ts 2>&1

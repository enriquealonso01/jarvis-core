#!/usr/bin/env bash
# The two ways a migration file has taken production down, made into rules.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/migration-hygiene-test.ts 2>&1

#!/usr/bin/env bash
# The suites are under the typechecker, and stay under it.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/scripts-typecheck-test.ts 2>&1

#!/usr/bin/env bash
# The canary (Part V, S12b item 3): seed a credential with a known unique value,
# exercise the system hard, then grep every log, audit row, issue and artifact
# for it. Zero hits.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s12b-canary-test.ts 2>&1

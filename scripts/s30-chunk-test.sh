#!/usr/bin/env bash
# Uniform chunking is the commonest cause of bad answers.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s30-chunk-test.ts 2>&1

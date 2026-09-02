#!/usr/bin/env bash
# Tier 1 answers in about a second, against the real providers.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/tier1-latency-test.ts 2>&1

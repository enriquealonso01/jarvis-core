#!/usr/bin/env bash
# The voice create-a-project call that failed, as a regression suite.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T   runner node --import tsx scripts/voice-create-test.ts 2>&1

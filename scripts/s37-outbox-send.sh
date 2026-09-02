#!/usr/bin/env bash
# S37 item 4 - the outbox reaches the bridge exactly once.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  -e INTERNAL_HMAC=test-secret \
  runner node --import tsx scripts/s37-outbox-send.ts 2>&1

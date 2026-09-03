#!/usr/bin/env bash
# S39 wired — the live spoken answer no longer dictates a URL.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s39-spoken-link-wired-test.ts 2>&1

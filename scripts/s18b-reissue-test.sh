#!/usr/bin/env bash
# S18b — an expired link offers a fresh one, delivered to WhatsApp.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm -T \
  runner node --import tsx scripts/s18b-reissue-test.ts 2>&1

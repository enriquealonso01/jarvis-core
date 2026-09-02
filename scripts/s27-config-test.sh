#!/usr/bin/env bash
# S27 - configuration by conversation: one write path, versioned and reversible.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s27-config-test.ts 2>&1

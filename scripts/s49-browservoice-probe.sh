#!/usr/bin/env bash
# S49 — live browser voice, probed adversarially.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s49-browservoice-probe.ts 2>&1

#!/usr/bin/env bash
# S53 — many-agent orchestration, probed adversarially.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s53-orchestration-probe.ts 2>&1

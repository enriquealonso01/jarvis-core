#!/usr/bin/env bash
# Jarvis must not reject its own outbound call legs.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  -e JARVIS_TELNYX=fake \
  runner node --import tsx scripts/outbound-leg-test.ts 2>&1

#!/usr/bin/env bash
# S23 — Jarvis calls Enrique: the six reasons, quiet hours, and the one override.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  -e JARVIS_TELNYX=fake \
  -e JARVIS_SITE_YAML=/app/scripts/fixtures/s19-site.yaml \
  runner node --import tsx scripts/s23-outbound-test.ts 2>&1

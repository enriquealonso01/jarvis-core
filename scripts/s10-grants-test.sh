#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T runner \
  node --import tsx scripts/s10-grants-test.ts 2>&1 | sed '/^ *$/d'

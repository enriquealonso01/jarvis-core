#!/usr/bin/env bash
# A schema the documentation does not describe is a schema nobody can read.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s18b-datamodel-test.ts 2>&1

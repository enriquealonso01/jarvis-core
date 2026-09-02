#!/usr/bin/env bash
# S26 - project onboarding writes the project's AGENTS.md, or refuses to.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s26-onboarding-test.ts 2>&1

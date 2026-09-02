#!/usr/bin/env bash
# A fixture project gets its own GitHub API credential, so it can open its PR.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/project-api-credential-test.ts 2>&1

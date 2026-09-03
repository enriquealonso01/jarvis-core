#!/usr/bin/env bash
# Supersede a document and assert what retrieval SEES, per chunk id — not what
# the answer says, which can be right for the wrong reason.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s30-supersede-index-test.ts 2>&1

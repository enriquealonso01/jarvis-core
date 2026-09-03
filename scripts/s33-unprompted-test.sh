#!/usr/bin/env bash
# S33 — a closed list of reasons Jarvis may open a conversation.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s33-unprompted-test.ts 2>&1

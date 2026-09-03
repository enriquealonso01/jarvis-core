#!/usr/bin/env bash
# S38 — a long answer is a document, and how it travels is a security decision.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s38-brevity-test.ts 2>&1

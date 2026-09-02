#!/usr/bin/env bash
# S28 - a task pointed at the wrong runtime parks, and says which wrong it was.
#
# JARVIS_HARNESS=claude on purpose. Every other offline suite runs under the
# fake, and under the fake the runtime is always the fake - which is correct in
# production terms and makes the whole selection path unreachable. Running this
# one in real mode is what lets it see the real decisions; nothing is spawned,
# because every case parks before it gets that far.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  -e JARVIS_HARNESS=claude \
  runner node --import tsx scripts/s28-park-test.ts 2>&1

#!/usr/bin/env bash
# S46, wired — the sign-in link reaches his phone, not only the browser.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  -e JARVIS_DEVICEFLOW=fake \
  runner node --import tsx scripts/s46-handoff-wired-test.ts 2>&1

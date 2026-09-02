#!/usr/bin/env bash
# A project created by talking, through the real dispatcher. Only the model is faked.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T   -e JARVIS_MODEL=fake   -e JARVIS_FAKE_MODEL_SCRIPT=/app/scripts/fixtures/voice-create-script.json   runner node --import tsx scripts/voice-create-e2e.ts 2>&1

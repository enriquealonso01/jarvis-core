#!/usr/bin/env bash
# S37 - content Enrique did not author cannot authorise anything.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T   -e JARVIS_MODEL=fake   -e JARVIS_FAKE_MODEL_SCRIPT=/app/scripts/fixtures/s2-model-script.json   runner node --import tsx scripts/s37-untrusted-test.ts 2>&1

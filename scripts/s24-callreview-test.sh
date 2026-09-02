#!/usr/bin/env bash
# S24 — a call is as reviewable as a chat thread, and audio retention holds.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  -e JARVIS_TELNYX=fake \
  -e JARVIS_TTS=fake \
  -e JARVIS_MODEL=fake \
  -e JARVIS_ENDPOINT_MS=300 \
  -e JARVIS_TURN_SCALE=0.2 \
  -e JARVIS_FAKE_MODEL_SCRIPT=/app/scripts/fixtures/s21-phone-script.json \
  -e JARVIS_SITE_YAML=/app/scripts/fixtures/s19-site.yaml \
  runner node --import tsx scripts/s24-callreview-test.ts 2>&1

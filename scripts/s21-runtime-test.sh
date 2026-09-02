#!/usr/bin/env bash
# S21 — the conversational orchestration runtime.
#
# The turn shape is scaled down (JARVIS_TURN_SCALE) so the 25-second budget
# ladder can be exercised in a couple of seconds; the suite reads the shipped
# numbers from a second process so the scaling cannot become the thing tested.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
COMPOSE="docker compose -f deploy/compose.dev.yaml"

$COMPOSE run --rm --no-deps -T \
  -e JARVIS_TELNYX=fake \
  -e JARVIS_TTS=fake \
  -e JARVIS_MODEL=fake \
  -e JARVIS_ENDPOINT_MS=300 \
  -e JARVIS_TURN_SCALE=0.12 \
  -e JARVIS_FAKE_MODEL_SCRIPT=/app/scripts/fixtures/s21-phone-script.json \
  -e JARVIS_SITE_YAML=/app/scripts/fixtures/s19-site.yaml \
  runner node --import tsx scripts/s21-runtime-test.ts 2>&1

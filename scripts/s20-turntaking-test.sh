#!/usr/bin/env bash
# S20 — turn-taking and barge-in.
#
# The endpoint window is shortened to 600ms so a pause assertion costs
# milliseconds rather than six seconds; the suite spawns a second process with
# the override removed to prove the shipped default is still five seconds.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
COMPOSE="docker compose -f deploy/compose.dev.yaml"

$COMPOSE run --rm --no-deps -T \
  -e JARVIS_TELNYX=fake \
  -e JARVIS_TTS=fake \
  -e JARVIS_MODEL=fake \
  -e JARVIS_ENDPOINT_MS=600 \
  -e JARVIS_FAKE_MODEL_SCRIPT=/app/scripts/fixtures/s19-phone-script.json \
  -e JARVIS_SITE_YAML=/app/scripts/fixtures/s19-site.yaml \
  runner node --import tsx scripts/s20-turntaking-test.ts 2>&1

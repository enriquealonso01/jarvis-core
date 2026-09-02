#!/usr/bin/env bash
# S22 — the desk actually does the work.
#
# The turn shape is left at a realistic-but-quick scale: this suite is about
# effects (tasks, projects, objectives, reports), not about the millisecond
# ladder, which S21 owns.
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
  -e JARVIS_TURN_SCALE=0.2 \
  -e JARVIS_FAKE_MODEL_SCRIPT=/app/scripts/fixtures/s21-phone-script.json \
  -e JARVIS_SITE_YAML=/app/scripts/fixtures/s19-site.yaml \
  runner node --import tsx scripts/s22-desk-test.ts 2>&1

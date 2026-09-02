#!/usr/bin/env bash
# S19 — call reliability hardening, driven by synthesised Telnyx webhooks.
#
# Everything the call path talks to is faked at its own edge: the carrier
# (JARVIS_TELNYX), the voice (JARVIS_TTS), the model (JARVIS_MODEL). What is NOT
# faked is the handler, the state machine, or the database — which is the whole
# point, because both regressions this guards against were in the handler.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
COMPOSE="docker compose -f deploy/compose.dev.yaml"

# Its own calls, its own tickets: the elevenlabs assertion counts open issues.
$COMPOSE exec -T postgres psql -U jarvis -d jarvis -tAX -c \
  "DELETE FROM issues WHERE dedupe_key = 'elevenlabs-render-failed';" >/dev/null 2>&1

$COMPOSE run --rm --no-deps -T \
  -e JARVIS_TELNYX=fake \
  -e JARVIS_TTS=fake \
  -e JARVIS_MODEL=fake \
  -e JARVIS_ENDPOINT_MS=400 \
  -e JARVIS_FAKE_MODEL_SCRIPT=/app/scripts/fixtures/s19-phone-script.json \
  -e JARVIS_SITE_YAML=/app/scripts/fixtures/s19-site.yaml \
  runner node --import tsx scripts/s19-call-test.ts 2>&1

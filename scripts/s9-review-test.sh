#!/usr/bin/env bash
# S9 review, against the scripted reviewer channel of the fake model.
#
# JARVIS_MODEL must be set on the container that RUNS the review. The first
# version of this script set it only on the api service, so quickCompletion fell
# through to real providers, found none, and every review returned "no reviewer
# route answered" — which read as the review failing rather than as the test
# being misconfigured.
set -uo pipefail
cd "$(dirname "$0")/.."
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  -e JARVIS_MODEL=fake \
  -e JARVIS_FAKE_MODEL_SCRIPT=/app/scripts/fixtures/s2-model-script.json \
  runner node --import tsx scripts/s9-review-test.ts 2>&1 | sed '/^ *$/d'

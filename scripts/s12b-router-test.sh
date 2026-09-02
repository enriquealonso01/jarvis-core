#!/usr/bin/env bash
# S12b item 1 — the deterministic router (ADR 005 Stage B). The plan's test is
# about MODEL CALLS: a #project-slug message reaches zero, and a code-shaped body
# routes globally without one.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  -e JARVIS_MODEL=fake \
  -e JARVIS_FAKE_MODEL_SCRIPT=/app/scripts/fixtures/s2-model-script.json \
  runner node --import tsx scripts/s12b-router-test.ts 2>&1

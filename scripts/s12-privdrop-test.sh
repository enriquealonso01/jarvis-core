#!/usr/bin/env bash
# S12's wall (ADR 016): a cross-project read fails EACCES, at the filesystem
# layer, rather than being caught by the command scanner and succeeding anyway.
#
# Runs as root inside the runner container because it creates real unix users —
# which is what the assertion is about. On the box the same model is built by
# deploy/provision-project-user.sh.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
COMPOSE="docker compose -f deploy/compose.dev.yaml"

$COMPOSE run --rm --no-deps -T runner node --import tsx scripts/s12-privdrop-test.ts 2>&1

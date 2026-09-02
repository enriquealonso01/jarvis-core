#!/usr/bin/env bash
# S7's refusal paths, run against the local SSH git host.
set -uo pipefail
cd "$(dirname "$0")/.."

# Git Bash on Windows rewrites anything shaped like a unix path in an argument
# into a Windows path, so `-e JARVIS_FAKE_MODEL_SCRIPT=/app/scripts/...` reached
# the container as `C:/Program Files/Git/app/scripts/...`. The fixture then
# failed to load, the fake model answered with nothing, and the suite reported a
# product failure ("no reviewer route answered") for a bug that was entirely in
# the shell. It cost an afternoon twice. Suites must not depend on which shell
# started them.
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
COMPOSE="docker compose -f deploy/compose.dev.yaml"
# iso-alpha and its deploy key come from the S5 fixture.
$COMPOSE up -d --no-build sshgit >/dev/null 2>&1
sleep 2
$COMPOSE run --rm --no-deps -T -e "JARVIS_GIT_URL_TEMPLATE={owner}@sshgit:{repo}" \
  runner node --import tsx scripts/s7-pullrequest-test.ts 2>&1 | sed '/^ *$/d'
rc=${PIPESTATUS[0]}
$COMPOSE stop sshgit >/dev/null 2>&1
exit $rc

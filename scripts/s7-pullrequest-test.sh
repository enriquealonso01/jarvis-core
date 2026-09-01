#!/usr/bin/env bash
# S7's refusal paths, run against the local SSH git host.
set -uo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f deploy/compose.dev.yaml"
# iso-alpha and its deploy key come from the S5 fixture.
$COMPOSE up -d --no-build sshgit >/dev/null 2>&1
sleep 2
$COMPOSE run --rm --no-deps -T -e "JARVIS_GIT_URL_TEMPLATE={owner}@sshgit:{repo}" \
  runner node --import tsx scripts/s7-pullrequest-test.ts 2>&1 | sed '/^ *$/d'
rc=${PIPESTATUS[0]}
$COMPOSE stop sshgit >/dev/null 2>&1
exit $rc

#!/usr/bin/env bash
# Drive scripts/s5-isolation-test.ts in two phases: generate and authorise the
# keys, restart sshd so it picks up the new authorized_keys, then assert.
set -uo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f deploy/compose.dev.yaml"

$COMPOSE up -d --no-build sshgit >/dev/null 2>&1
sleep 3

echo "--- phase 1: keys ---"
$COMPOSE run --rm --no-deps -T -e S5_KEYS_ONLY=1 -e "JARVIS_GIT_URL_TEMPLATE={owner}@sshgit:{repo}" -v jarvis-dev_sshgit_keys:/keys \
  runner node --import tsx scripts/s5-isolation-test.ts 2>&1 | sed '/^ *$/d'

echo
echo "--- restarting sshgit so it reads the new authorized_keys ---"
$COMPOSE restart sshgit >/dev/null 2>&1
sleep 4

echo "--- phase 2: isolation ---"
$COMPOSE run --rm --no-deps -T -e "JARVIS_GIT_URL_TEMPLATE={owner}@sshgit:{repo}" -v jarvis-dev_sshgit_keys:/keys \
  runner node --import tsx scripts/s5-isolation-test.ts 2>&1 | sed '/^ *$/d'
rc=$?
$COMPOSE stop sshgit >/dev/null 2>&1
exit $rc

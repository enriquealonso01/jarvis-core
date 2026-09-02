#!/usr/bin/env bash
# Drive scripts/s5-isolation-test.ts in two phases: generate and authorise the
# keys, restart sshd so it picks up the new authorized_keys, then assert.
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

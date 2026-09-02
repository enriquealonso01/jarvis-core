#!/usr/bin/env bash
# S18 — global search and the activity feed (API), then the palette (browser).
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
COMPOSE="docker compose -f deploy/compose.dev.yaml"

bash scripts/console-rebuild.sh >/dev/null || {
  echo "  FAIL  the console did not build — see /tmp/console-build.log"
  echo "==== 0 passed, 1 failed ===="; exit 1; }

a=$($COMPOSE run --rm --no-deps -T runner node --import tsx scripts/s18-search-test.ts 2>&1); echo "$a"
b=$(node scripts/s18-palette-test.mjs 2>&1); echo "$b"

sum() { printf '%s' "$1" | grep -oE '==== [0-9]+ passed, [0-9]+ failed ====' | tail -1; }
ap=$(sum "$a" | grep -oE '^==== [0-9]+' | grep -oE '[0-9]+'); af=$(sum "$a" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+')
bp=$(sum "$b" | grep -oE '^==== [0-9]+' | grep -oE '[0-9]+'); bf=$(sum "$b" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+')
echo
echo "==== $(( ${ap:-0} + ${bp:-0} )) passed, $(( ${af:-1} + ${bf:-1} )) failed ===="
[ "$(( ${af:-1} + ${bf:-1} ))" -eq 0 ]

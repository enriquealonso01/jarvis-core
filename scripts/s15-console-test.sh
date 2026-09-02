#!/usr/bin/env bash
# S15 — the console audit (every page, phone width) plus the forced states.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

bash scripts/console-rebuild.sh >/dev/null || {
  echo "  FAIL  the console did not build — see /tmp/console-build.log"
  echo "==== 0 passed, 1 failed ===="; exit 1; }

a=$(node scripts/s15-console-audit.mjs 2>&1); echo "$a"
b=$(node scripts/s15-states-test.mjs 2>&1);  echo "$b"

sum() { printf '%s' "$1" | grep -oE '==== [0-9]+ passed, [0-9]+ failed ====' | tail -1; }
ap=$(sum "$a" | grep -oE '^==== [0-9]+' | grep -oE '[0-9]+'); af=$(sum "$a" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+')
bp=$(sum "$b" | grep -oE '^==== [0-9]+' | grep -oE '[0-9]+'); bf=$(sum "$b" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+')
echo
echo "==== $(( ${ap:-0} + ${bp:-0} )) passed, $(( ${af:-1} + ${bf:-1} )) failed ===="
[ "$(( ${af:-1} + ${bf:-1} ))" -eq 0 ]

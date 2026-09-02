#!/usr/bin/env bash
# S14's suite is a browser watching a real run, so the work is in the .mjs. This
# wrapper rebuilds the console first — measuring a stale export would test the
# previous version of the page and report it as the current one.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

CONSOLE="${JARVIS_CONSOLE_DIR:-../jarvis-control-center}"
if [ -d "$CONSOLE" ]; then
  (cd "$CONSOLE" && pnpm build) >/tmp/s14-build.log 2>&1 \
    || { echo "  FAIL  the console did not build — see /tmp/s14-build.log"; echo "==== 0 passed, 1 failed ===="; exit 1; }
else
  echo "  SKIP  no console checkout at $CONSOLE"
  echo "==== 0 passed, 0 failed ===="
  exit 0
fi

node scripts/s14-live-detail-test.mjs

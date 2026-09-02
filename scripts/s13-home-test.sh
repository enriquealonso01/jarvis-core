#!/usr/bin/env bash
# S13's suite is a browser measurement, so the work is in the .mjs. This wrapper
# exists so the sweep can run every suite the same way, and so the console is
# rebuilt first — measuring a stale export would measure the previous layout and
# report it as the current one.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

CONSOLE="${JARVIS_CONSOLE_DIR:-../jarvis-control-center}"
if [ -d "$CONSOLE" ]; then
  (cd "$CONSOLE" && pnpm build) >/tmp/s13-build.log 2>&1 \
    || { echo "  FAIL  the console did not build — see /tmp/s13-build.log"; echo "==== 0 passed, 1 failed ===="; exit 1; }
else
  echo "  SKIP  no console checkout at $CONSOLE"
  echo "==== 0 passed, 0 failed ===="
  exit 0
fi

node scripts/s13-home-test.mjs

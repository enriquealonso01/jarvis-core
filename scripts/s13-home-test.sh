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
if [ ! -d "$CONSOLE" ]; then
  echo "  SKIP  no console checkout at $CONSOLE"
  echo "==== 0 passed, 0 failed ===="
  exit 0
fi
# Shared with S15: `next build` type-checks after it compiles, so a broken tree
# leaves the previous export in place and a suite measures the last good build.
bash scripts/console-rebuild.sh >/dev/null || {
  echo "  FAIL  the console did not build — see /tmp/console-build.log"
  echo "==== 0 passed, 1 failed ===="; exit 1; }

# Stamp the built progress fixture with the current time.
#
# `public/PROGRESS.json` is a committed fixture, so its `updated_at` recedes into
# the past as the repository ages. Past twenty-four hours the bar correctly draws
# "Last updated 25h ago" in the warning colour - and this suite correctly reports
# an alarm colour on an otherwise calm Home. Both halves were right and the suite
# still failed, purely because a file got older.
#
# The BUILT copy is stamped rather than the tracked one: a test that leaves the
# working tree dirty every time it runs is a test people stop running. Production
# is unaffected either way, because Caddy serves /PROGRESS.json from the API and
# never from the static export.
node -e "
  const fs = require('node:fs');
  const p = process.argv[1];
  if (!fs.existsSync(p)) process.exit(0);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  d.updated_at = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(d, null, 2));
" "${JARVIS_CONSOLE_DIR:-../jarvis-control-center}/out/PROGRESS.json"

node scripts/s13-home-test.mjs

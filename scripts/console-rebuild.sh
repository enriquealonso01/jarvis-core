#!/usr/bin/env bash
# Rebuild the Control Center export, and refuse to hand back a stale one.
#
# `next build` type-checks AFTER it compiles, so a type error leaves the previous
# `out/` exactly where it was and exits non-zero. A test that then measures
# `out/` measures the LAST GOOD BUILD and reports green for code that does not
# compile — which is how a deliberate sabotage passed the S15 state suite 10/10.
# The same shape has now cost time three times (twice in Docker, once here), so
# this is the same guard dev-rebuild.sh applies to the images.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

CONSOLE="${JARVIS_CONSOLE_DIR:-../jarvis-control-center}"
if [ ! -d "$CONSOLE" ]; then
  echo "no console checkout at $CONSOLE" >&2
  exit 2
fi

if ! (cd "$CONSOLE" && pnpm build) >/tmp/console-build.log 2>&1; then
  echo "REFUSING: the console does not build. The export in out/ is the previous one." >&2
  tail -25 /tmp/console-build.log >&2
  exit 1
fi

# Belt and braces: the export must be newer than every source file that feeds it.
newest_src=$(find "$CONSOLE/app" "$CONSOLE/lib" -type f \
  \( -name '*.tsx' -o -name '*.ts' -o -name '*.css' \) -printf '%T@\n' 2>/dev/null | sort -n | tail -1)
built=$(stat -c '%Y' "$CONSOLE/out/index.html" 2>/dev/null || echo 0)
if [ -n "$newest_src" ] && [ "${built%.*}" -lt "${newest_src%.*}" ]; then
  echo "REFUSING: out/index.html is older than the sources — the build did not land." >&2
  exit 1
fi

echo "console rebuilt: $(find "$CONSOLE/out" -type f | wc -l) files"

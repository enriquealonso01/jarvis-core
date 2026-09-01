#!/usr/bin/env bash
# Push PROGRESS.json to the Control Center without rebuilding it.
#
# The bar fetches /PROGRESS.json at runtime, so keeping it current costs one
# file copy rather than a Next.js build and a 74-file deploy. Run this in the
# same breath as updating the file, so prod never shows a state the repo has
# already moved past.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/progress-sync.mjs "$@" >/dev/null
ssh -o BatchMode=yes jarvis-netcup \
  'cat > /opt/jarvis/control-center/PROGRESS.json && chmod 0644 /opt/jarvis/control-center/PROGRESS.json' \
  < PROGRESS.json
printf 'published: %s\n' "$(curl -s https://jarvis.enriquecodes.com/PROGRESS.json | head -c 120)"

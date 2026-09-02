#!/usr/bin/env bash
# Obsolete. There is nothing to publish any more.
#
# This script used to copy PROGRESS.json into the Control Center's static root,
# where the build bar fetched it. That copy is what went 21 hours stale --
# reporting S5 / 37 steps against a repo on S25 / 40 -- because the script was
# run by hand, and its own comment told you to run it "in the same breath" as
# editing the file. That is an instruction, not a mechanism. A console deploy
# then removed the copy outright, because deploy-control-center.sh rsyncs with
# --delete.
#
# The bar now fetches /PROGRESS.json from the API, which reads
# /opt/jarvis/core/PROGRESS.json -- the deployed source tree, which is also the
# images' build context and what the host runner executes. One file on the box,
# updated by the same action that ships code.
#
# Kept as a signpost rather than deleted, so anyone who runs it out of habit
# finds out why it does nothing instead of assuming it worked.
set -euo pipefail
cd "$(dirname "$0")/.."

cat <<'EOF'
progress-publish.sh does nothing now, on purpose.

The build bar reads /PROGRESS.json from the API, served from the deployed
source tree at /opt/jarvis/core/PROGRESS.json. There is no second copy to keep
in step.

To move the live bar: change PROGRESS.json, then deploy core the usual way
(extract into /opt/jarvis/core, build, docker compose up -d --build api worker).
EOF

printf '\nlive now: %s\n' \
  "$(curl -s https://jarvis.enriquecodes.com/PROGRESS.json | head -c 120)"

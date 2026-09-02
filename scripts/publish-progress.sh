#!/usr/bin/env bash
#
# Publish the build bar state to the box.
#
# PROGRESS.json and BLOCKED.md are STATE, not code, and they are published on a
# different clock: the plan changes when a step lands, which is rarely, and the
# state changes several times per step. Publishing must therefore be a file
# copy - no image rebuild, no container restart, no console redeploy.
#
# They are served out of /var/lib/jarvis/state, deliberately NOT out of
# /opt/jarvis/core. The core tree is the deploy target: every code deploy
# extracts a tarball over it, and that tarball carries whatever PROGRESS.json
# happened to be on the branch being deployed. So a code deploy from a feature
# branch silently reverted the bar to that branch version of the truth. That is
# exactly what happened - the reconciled 51 step file was on main while the box
# served a 40 step copy from a branch, and the bar read S28 of 40.
#
# Usage: scripts/publish-progress.sh [ref]      (default: origin/main)
set -euo pipefail

REF="${1:-origin/main}"
HOST="${JARVIS_HOST:-jarvis-netcup}"
DEST=/var/lib/jarvis/state

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# From the ref, never from the working tree: what is published has to be a
# committed, reviewable state, not whatever is open in an editor.
git show "$REF:PROGRESS.json" > "$tmp/PROGRESS.json"
git show "$REF:BLOCKED.md"   > "$tmp/BLOCKED.md"

python -c "import json,sys; json.load(open(sys.argv[1]))" "$tmp/PROGRESS.json"

scp -q "$tmp/PROGRESS.json" "$tmp/BLOCKED.md" "$HOST:/tmp/"
# Moved into place, not written in place: the API reads this file on every
# request, so a partial write would be served.
ssh "$HOST" "sudo mkdir -p $DEST && sudo mv /tmp/PROGRESS.json /tmp/BLOCKED.md $DEST/ && sudo chmod 644 $DEST/PROGRESS.json $DEST/BLOCKED.md"

echo "published $REF:"
curl -s https://jarvis.enriquecodes.com/PROGRESS.json | python -c "import json,sys; d=json.load(sys.stdin); print('  total_steps', d['total_steps'], 'current', d['current_step'], 'working_on', repr(d.get('working_on'))[:60])"

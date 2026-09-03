#!/usr/bin/env bash
#
# Deploy the core tree to the box.
#
# This was a command remembered and retyped each time, which is how two
# problems got in. The first is ownership: a tarball built on Windows carries
# the builder's uid, and 197609 does not exist on the box - so 144 files under
# /opt/jarvis, including the directory itself, ended up owned by a user that is
# not there. Nothing has broken loudly yet, which is exactly why it is worth
# fixing now rather than during an incident.
#
# The second is that a remembered sequence drifts. The order below is not
# arbitrary:
#
#   1. extract into /opt/jarvis/core - it is the image build context, so the
#      containers are built from what is on disk, not from what was pushed
#   2. chown, so the jarvis user can write dist/
#   3. build as jarvis
#   4. rebuild the containers
#   5. restart the host runner, which runs outside docker
#
# Usage:
#   scripts/deploy-core.sh                 code, containers, runner
#   scripts/deploy-core.sh --no-runner     leave the runner alone
#   scripts/deploy-core.sh --no-containers code only
#
# --no-runner exists for a real case: the heavy lane may be mid-run, and
# restarting the runner under a benchmark campaign costs the run in flight.
set -euo pipefail

HOST="${JARVIS_HOST:-jarvis-netcup}"
CORE=/opt/jarvis/core
RESTART_RUNNER=1
REBUILD_CONTAINERS=1

for arg in "$@"; do
  case "$arg" in
    --no-runner) RESTART_RUNNER=0 ;;
    --no-containers) REBUILD_CONTAINERS=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --owner/--group/--numeric-owner: without these the archive carries the
# Windows uid and tar recreates it on extraction, since the extract runs as
# root and root is allowed to chown to anything - including a user that does
# not exist.
echo "==> packing"
tar -czf "$tmp/core.tgz" \
  --owner=0 --group=0 --numeric-owner \
  --exclude=node_modules --exclude=.git --exclude=dist .

scp -q "$tmp/core.tgz" "$HOST:/tmp/jarvis-core.tgz"

echo "==> extracting into $CORE"
ssh "$HOST" "sudo tar -xzf /tmp/jarvis-core.tgz -C $CORE && sudo chown -R jarvis:jarvis $CORE"

echo "==> building"
ssh "$HOST" "cd $CORE && sudo -u jarvis pnpm build 2>&1 | tail -2"

if [ "$REBUILD_CONTAINERS" = "1" ]; then
  echo "==> containers"
  ssh "$HOST" "cd /opt/jarvis/deploy && sudo docker compose up -d --build api worker 2>&1 | tail -3"
fi

if [ "$RESTART_RUNNER" = "1" ]; then
  echo "==> runner"
  ssh "$HOST" "sudo systemctl restart jarvis-runner && sleep 3 && systemctl is-active jarvis-runner"
else
  echo "==> runner left running (--no-runner)"
fi

# Verified on the box rather than assumed: a deploy that extracted but did not
# build leaves the old dist in place and every check short of this one passes.
echo "==> verifying"
ssh "$HOST" "test -f $CORE/dist/index.js && echo 'dist present' && sudo find /opt/jarvis -uid 197609 | wc -l | xargs -I{} echo 'files owned by the phantom uid: {}'"

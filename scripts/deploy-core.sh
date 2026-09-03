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

# Refuse to ship what is not in git.
#
# This script packs the WORKING TREE, not a git ref - deliberately, because the
# image build context is what is on disk. The cost of that showed up on
# 2026-09-03: `migrations/045_outbox_dropped.sql` was an untracked file left in
# a working tree, every deploy tarred it, and the API applied it. Production
# ended up carrying a migration that exists in no branch and no commit, and the
# only copy was on one laptop. Two more - 041_connection_actions and
# 042_mcp_tools - arrived the same way from a feature branch that was never
# merged, leaving two tables on the box that no code in main references.
#
# migrations/ is the dangerous directory because applying one is irreversible in
# practice: the row persists, the table persists, and a later deploy from main
# neither notices nor undoes it. So this fails closed there and only there.
# Everything else may legitimately differ while iterating.
dirty_migrations="$(git status --porcelain -- migrations/ 2>/dev/null || true)"
if [ -n "$dirty_migrations" ] && [ "${DEPLOY_ALLOW_DIRTY_MIGRATIONS:-0}" != "1" ]; then
  echo "refusing to deploy: migrations/ has changes that are not committed" >&2
  echo "$dirty_migrations" >&2
  echo >&2
  echo "A migration reaches production the moment it is packed, and applying it" >&2
  echo "cannot be undone by deploying main again. Commit it, or move it out of" >&2
  echo "the tree. Set DEPLOY_ALLOW_DIRTY_MIGRATIONS=1 only if you mean it." >&2
  exit 1
fi

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

# Report source files the box has and the tree does not.
#
# The extract lays the tarball over /opt/jarvis/core; it never removes what is
# no longer shipped. So a deploy from a branch leaves its files behind for good.
# Found 2026-09-03: adapters.ts and connector.ts, from feat/s31-connector-interface,
# a branch that was never merged - still on the box, still compiled into dist by
# every build, imported by nothing.
#
# Dead code is the small half. The real cost is that a future `import "./connector.js"`
# would RESOLVE, silently picking up an abandoned implementation instead of
# failing the build the way a missing module should.
#
# This reports rather than deletes. Removing files from the production tree is a
# decision, and a deploy script that quietly deletes is how the wrong thing goes
# at the wrong moment.
echo "==> checking for stale source on the box"
ssh "$HOST" "ls $CORE/src/*.ts 2>/dev/null | xargs -n1 basename | LC_ALL=C sort" > "$tmp/box-src.txt" 2>/dev/null || true
ls src/*.ts 2>/dev/null | xargs -n1 basename | LC_ALL=C sort > "$tmp/tree-src.txt" || true
stale="$(LC_ALL=C comm -23 "$tmp/box-src.txt" "$tmp/tree-src.txt" 2>/dev/null || true)"
if [ -n "$stale" ]; then
  echo "    WARNING: on the box but not in this tree - left by an earlier deploy:" >&2
  echo "$stale" | sed 's/^/      /' >&2
  echo "    They are still compiled by every build. Remove them deliberately, not here." >&2
else
  echo "    none"
fi

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

# Did the API actually come back?
#
# On 2026-09-03 a migration of mine referenced a column that does not exist.
# Migrations run before the API serves, so it threw on startup and the container
# crash-looped - and this script printed "dist present" and exited 0 through the
# whole outage, because everything above verifies the BUILD. The deploy was
# green and the service was down, which is the exact failure this project keeps
# finding in other people's code.
#
# Polled rather than checked once: a healthy API still takes a few seconds to
# run migrations and bind, so a single immediate probe would fail every good
# deploy and get deleted within a week.
echo "==> waiting for the API to answer"
if ssh "$HOST" 'for i in $(seq 1 30); do
      code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:8080/api/health || true)
      if [ "$code" = "200" ]; then echo "    API healthy after ${i}s"; exit 0; fi
      sleep 1
    done
    echo "    API DID NOT COME BACK - last status: ${code:-no response}" >&2
    docker ps --filter name=jarvis-api --format "    {{.Names}} {{.Status}}" >&2
    docker logs --tail 15 jarvis-api-1 2>&1 | sed "s/^/    /" >&2
    exit 1'; then
  :
else
  echo "the deploy finished but the API is not serving - see the log above" >&2
  exit 1
fi

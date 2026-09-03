#!/usr/bin/env bash
# Publish a Control Center static export on the Netcup host.
#
# Caddy bind-mounts /opt/jarvis/control-center. Replacing that directory with
# `mv` swaps the inode underneath the running container, so Caddy keeps serving
# the old (or a deleted) directory and the whole site 404s until the container
# is recreated. Always sync the *contents* in place instead.
#
# Usage (on the host):  deploy-control-center.sh /tmp/cc-out.tgz
set -euo pipefail

TARBALL="${1:-/tmp/cc-out.tgz}"
# Overridable only so the ownership check can run against a scratch directory
# without republishing the live console.
TARGET="${JARVIS_CC_TARGET:-/opt/jarvis/control-center}"
STAGE="$(mktemp -d /tmp/cc-stage.XXXXXX)"

trap 'rm -rf "$STAGE"' EXIT

if [ ! -f "$TARBALL" ]; then
  echo "no tarball at $TARBALL" >&2
  exit 1
fi

tar xzf "$TARBALL" -C "$STAGE"

if [ ! -f "$STAGE/index.html" ]; then
  echo "refusing to publish: $TARBALL has no index.html at its root" >&2
  exit 1
fi

mkdir -p "$TARGET"

# --delete removes files dropped from the export; the directory itself, and so
# the bind mount, is never replaced.
# Ownership comes from this host, never from the archive.
#
# The tarball is built on Windows, so every entry carries uid 197609 - a user
# that does not exist here. `rsync -a` and `cp -a` both preserve that, and
# running as root they are permitted to, so each console deploy quietly
# recreated files owned by nobody. 144 of them accumulated under /opt/jarvis
# before anyone looked. Nothing had broken yet, which is the only reason it
# survived this long.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --no-owner --no-group --delete "$STAGE"/ "$TARGET"/
else
  find "$TARGET" -mindepth 1 -delete
  cp -a "$STAGE"/. "$TARGET"/
fi
chown -R root:root "$TARGET"

echo "published $(find "$TARGET" -type f | wc -l) files to $TARGET"

# Said out loud, because a phantom uid is invisible until something needs to
# write as that user and cannot.
strays=$(find "$TARGET" -uid 197609 2>/dev/null | wc -l)
if [ "$strays" != "0" ]; then
  echo "WARNING: $strays files under $TARGET are owned by a uid that does not exist here" >&2
  exit 1
fi

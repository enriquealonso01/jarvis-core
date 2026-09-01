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
TARGET="/opt/jarvis/control-center"
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
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$STAGE"/ "$TARGET"/
else
  find "$TARGET" -mindepth 1 -delete
  cp -a "$STAGE"/. "$TARGET"/
fi

echo "published $(find "$TARGET" -type f | wc -l) files to $TARGET"

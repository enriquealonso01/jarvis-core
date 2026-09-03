#!/usr/bin/env bash
#
# A console deploy must not create files owned by a uid that does not exist.
#
# The export tarball is built on Windows, so every entry in it carries uid
# 197609. `rsync -a` running as root is permitted to recreate that ownership and
# did, on every console deploy, until 144 files under /opt/jarvis were owned by
# nobody. Nothing had broken, which is why it went unnoticed - a phantom uid is
# invisible until something needs to write as that user and cannot.
#
# Runs against a scratch target so the live console is never touched.
set -uo pipefail
HOST="${JARVIS_HOST:-jarvis-netcup}"
SCRATCH=/tmp/cc-owner-check
pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/site"
echo '<!doctype html><title>owner check</title>' > "$work/site/index.html"
echo 'body{}' > "$work/site/app.css"
# Built here, on Windows, exactly as a real export is - the uid in the archive
# is the whole point of the test.
tar -czf "$work/cc.tgz" -C "$work/site" .

echo "=== the archive really does carry a foreign uid ==="
uid=$(tar -tvzf "$work/cc.tgz" 2>/dev/null | head -1 | awk '{print $2}')
echo "    archive owner field: $uid"

scp -q "$work/cc.tgz" "$HOST:/tmp/cc-owner-check.tgz"
ssh "$HOST" "sudo rm -rf $SCRATCH" >/dev/null 2>&1

echo "=== deploying into a scratch target ==="
out=$(ssh "$HOST" "sudo JARVIS_CC_TARGET=$SCRATCH bash /opt/jarvis/core/scripts/deploy-control-center.sh /tmp/cc-owner-check.tgz; echo EXIT=\$?" 2>&1 | tr -d '\r')
echo "    $(echo "$out" | grep -E 'published|WARNING' | head -1)"
case "$out" in
  *EXIT=0*) ok "the deploy succeeded" ;;
  *) bad "the deploy failed: $(echo "$out" | tail -2 | tr '\n' ' ')" ;;
esac

strays=$(ssh "$HOST" "sudo find $SCRATCH -uid 197609 2>/dev/null | wc -l" | tr -d '\r')
if [ "$strays" = "0" ]; then
  ok "no files are owned by the phantom uid"
else
  bad "$strays files are owned by a uid that does not exist on the box"
fi

owner=$(ssh "$HOST" "sudo stat -c '%U' $SCRATCH/index.html 2>/dev/null" | tr -d '\r')
if [ "$owner" = "root" ]; then
  ok "and the published files belong to root, a user that is actually here"
else
  bad "index.html is owned by $owner"
fi

echo "=== and the live console is still owned correctly ==="
live=$(ssh "$HOST" "sudo find /opt/jarvis -uid 197609 2>/dev/null | wc -l" | tr -d '\r')
if [ "$live" = "0" ]; then ok "nothing under /opt/jarvis is owned by the phantom uid"; else bad "$live stray files remain under /opt/jarvis"; fi

ssh "$HOST" "sudo rm -rf $SCRATCH" >/dev/null 2>&1
echo ""
echo "==== $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]

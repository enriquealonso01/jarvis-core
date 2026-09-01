#!/bin/bash
# Isolation smoke: project dirs must not be world-readable; system projects only at boot.
set -euo pipefail
ROOT=/var/lib/jarvis
fail=0
for d in "$ROOT/projects" "$ROOT/worktrees" "$ROOT/artifacts" "$ROOT/keys"; do
  if [[ -d "$d" ]]; then
    mode=$(stat -c '%a' "$d")
    if [[ "$mode" == *7 || "$mode" == *6 ]]; then
      echo "WARN $d mode $mode is too open"
      fail=1
    fi
  fi
done
echo "isolation-check done fail=$fail"
exit "$fail"

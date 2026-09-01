#!/bin/bash
# Monthly restore probe: list snapshots. Full file restore is Maintenance's job; this fails closed.
set -euo pipefail
umask 077
# shellcheck disable=SC1091
set -a
source /etc/jarvis/restic.env
set +a
if ! restic snapshots --json >/tmp/jarvis-restic-snapshots.json; then
  logger -t jarvis-restore-test "restic snapshots failed"
  exit 1
fi
python3 - <<'PY'
import json
from pathlib import Path
data = json.loads(Path("/tmp/jarvis-restic-snapshots.json").read_text())
Path("/tmp/jarvis-restic-snapshots.json").unlink(missing_ok=True)
if not data:
    raise SystemExit("no snapshots")
print(f"restore-test ok snapshots={len(data)}")
PY

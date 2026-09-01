#!/usr/bin/env bash
# restic → B2. Fails closed if /etc/jarvis/restic.env is missing.
#
# The Postgres data directory is a named Docker volume, so a file-level backup of
# /var/lib/jarvis does NOT contain the database. The pg_dump below is the only
# copy of it, which makes where that dump lands load-bearing:
#
#   It must NOT go in /var/lib/jarvis/quarantine — that path is excluded (it
#   holds unscanned artifacts). Writing the dump there and then excluding the
#   directory silently produced database-free backups for the life of this box.
#
# The dump goes in /var/lib/jarvis/db-backup, which is inside the backup set and
# is not excluded, and the snapshot is verified to contain it before we prune.
set -euo pipefail
ENV_FILE="${RESTIC_ENV:-/etc/jarvis/restic.env}"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "restic not configured: create a B2 bucket and write ${ENV_FILE}" >&2
  echo "Required: B2_ACCOUNT_ID B2_ACCOUNT_KEY RESTIC_REPOSITORY RESTIC_PASSWORD" >&2
  exit 2
fi
# shellcheck disable=SC1090
set -a
source "${ENV_FILE}"
set +a

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_DIR="/var/lib/jarvis/db-backup"
DUMP="${DUMP_DIR}/pg-${STAMP}.dump"
install -d -m 0750 "${DUMP_DIR}"

if docker ps --format '{{.Names}}' | grep -qx jarvis-postgres-1; then
  docker exec jarvis-postgres-1 pg_dump -U jarvis -d jarvis --format=custom > "${DUMP}"
  # A dump that exists but is empty is worse than none: it looks like a backup.
  DUMP_BYTES=$(stat -c '%s' "${DUMP}")
  if [[ "${DUMP_BYTES}" -lt 10000 ]]; then
    echo "pg_dump produced only ${DUMP_BYTES} bytes; refusing to call this a backup" >&2
    rm -f "${DUMP}"
    exit 3
  fi
  echo "pg_dump ok ${DUMP_BYTES} bytes"
else
  echo "postgres container not running; refusing to run a database-free backup" >&2
  exit 4
fi

# --json so the new snapshot id can be captured. "latest" can still resolve to
# the previous snapshot in the moment right after a write.
BACKUP_JSON="$(mktemp)"
restic backup --one-file-system --json \
  /var/lib/jarvis \
  /etc/jarvis \
  --exclude /var/lib/jarvis/quarantine \
  --exclude /var/lib/jarvis/restore-drill \
  --exclude /var/lib/jarvis/browsers > "${BACKUP_JSON}"

SNAP_ID="$(python3 -c '
import json, sys
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    try:
        rec = json.loads(line)
    except ValueError:
        continue
    if rec.get("message_type") == "summary" and rec.get("snapshot_id"):
        print(rec["snapshot_id"])
        break
' "${BACKUP_JSON}")"
rm -f "${BACKUP_JSON}"

if [[ -z "${SNAP_ID}" ]]; then
  echo "could not determine the snapshot id; backup not verified" >&2
  exit 5
fi

# Verify the dump actually landed in the snapshot just written. A backup that
# silently drops the database is exactly the failure this guards against.
# The index can lag a moment behind the write, so retry rather than fail on a race.
verified=0
for _ in 1 2 3 4 5; do
  if restic ls "${SNAP_ID}" 2>/dev/null | grep -qx "${DUMP}"; then
    verified=1
    break
  fi
  sleep 2
done
if [[ "${verified}" -ne 1 ]]; then
  echo "dump ${DUMP} is missing from snapshot ${SNAP_ID}; backup is not usable" >&2
  exit 5
fi
echo "verified dump present in snapshot ${SNAP_ID}"

restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

# Keep only the newest few dumps locally; restic holds the history.
find "${DUMP_DIR}" -name 'pg-*.dump' -type f -printf '%T@ %p\n' \
  | sort -rn | tail -n +4 | cut -d' ' -f2- | xargs -r rm -f

echo "backup ok snapshot=${SNAP_ID} dump=$(basename "${DUMP}")"

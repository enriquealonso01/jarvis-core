#!/bin/bash
# Daily restic. Env is /etc/jarvis/restic.env (root-only). Do not log secrets.
set -euo pipefail
umask 077
export HOME=/root
# shellcheck disable=SC1091
set -a
source /etc/jarvis/restic.env
set +a
/usr/local/bin/jarvis-backup backup >/var/log/jarvis-backup.log 2>&1 || {
  logger -t jarvis-backup "backup failed; see /var/log/jarvis-backup.log"
  exit 1
}

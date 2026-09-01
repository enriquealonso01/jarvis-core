#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${RESTIC_ENV:-/etc/jarvis/restic.env}"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "restic not configured: ${ENV_FILE} missing" >&2
  exit 2
fi
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a
restic check
echo "verify-backup ok"

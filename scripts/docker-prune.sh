#!/bin/bash
# Unused Docker data only (no -a). Weekly Maintenance.
set -euo pipefail
docker system prune -f >/var/log/jarvis-docker-prune.log 2>&1

#!/usr/bin/env bash
# Four live faults from the box, 2026-09-02: directory ownership, the unscoped
# boundary, a private /tmp, and a denial that worked being filed as critical.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
docker compose -f deploy/compose.dev.yaml run --rm --no-deps -T \
  runner node --import tsx scripts/s12c-live-faults-test.ts 2>&1

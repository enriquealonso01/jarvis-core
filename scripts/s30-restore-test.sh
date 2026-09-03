#!/usr/bin/env bash
# S30 Done-when: a real pg_dump, a real pg_restore, and the same questions asked
# of the database that came back.
#
# The dump uses the same flags as scripts/jarvis-backup.sh (custom format, whole
# database) because the point is to exercise the backup Jarvis actually takes,
# not a convenient subset of it. A test that dumps only the tables it cares
# about proves those tables can round-trip and says nothing about the backup.
#
# pg_restore's exit status is CHECKED. scripts/restore-drill.sh used to end its
# restore with `|| true`, which means a restore that half-failed still reported
# every check it happened to look at as fine.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f deploy/compose.dev.yaml"
PG=jarvis-dev-postgres-1
PROBE=jarvis_restore_probe
DUMP=/tmp/s30-restore-probe.dump

runner() { $COMPOSE run --rm --no-deps -T "$@" 2>&1; }

cleanup() {
  docker exec "$PG" psql -U jarvis -d postgres -c "DROP DATABASE IF EXISTS $PROBE" >/dev/null 2>&1
  docker exec "$PG" rm -f "$DUMP" >/dev/null 2>&1
  runner runner node --import tsx scripts/s30-restore-test.ts cleanup >/dev/null
}
trap cleanup EXIT

echo "--- seeding the corpus and recording what it answers"
runner runner node --import tsx scripts/s30-restore-test.ts seed || exit 1

echo "--- pg_dump (custom format, whole database — the backup's own flags)"
docker exec "$PG" pg_dump -U jarvis -d jarvis --format=custom -f "$DUMP" || {
  echo "pg_dump failed" >&2; exit 1; }
BYTES=$(docker exec "$PG" stat -c '%s' "$DUMP")
echo "    ${BYTES} bytes"

echo "--- pg_restore into a throwaway database"
docker exec "$PG" psql -U jarvis -d postgres -c "DROP DATABASE IF EXISTS $PROBE" >/dev/null
docker exec "$PG" psql -U jarvis -d postgres -c "CREATE DATABASE $PROBE" >/dev/null
if ! docker exec "$PG" pg_restore -U jarvis -d "$PROBE" --no-owner "$DUMP"; then
  echo "pg_restore reported errors — a restore that half-worked is not a backup" >&2
  exit 1
fi

echo "--- asking the restored database the same questions"
runner -e DATABASE_URL="postgres://jarvis:dev@postgres:5432/$PROBE" \
  runner node --import tsx scripts/s30-restore-test.ts verify

#!/usr/bin/env bash
# FULL_LOOPS L15 — restore drill.
#
# Listing snapshots is not a restore test. This restores the latest snapshot into
# an isolated directory, loads the database dump into a throwaway database, and
# asserts that the rows and the encrypted credentials actually come back. It
# fails closed, touches nothing live, and cleans up after itself.
#
# It never prints a secret: the canary check compares fingerprints only.
set -euo pipefail
umask 077

ENV_FILE="${RESTIC_ENV:-/etc/jarvis/restic.env}"
[[ -f "${ENV_FILE}" ]] || { echo "restic not configured at ${ENV_FILE}" >&2; exit 2; }
# shellcheck disable=SC1090
set -a
source "${ENV_FILE}"
set +a

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_BYTES=0
SNAP_NAME="none"
CANARY_OK=0
DRILL_ROOT="/var/lib/jarvis/restore-drill"
TARGET="${DRILL_ROOT}/${STAMP}"
DRILL_DB="jarvis_restore_drill"
PG_CONTAINER="jarvis-postgres-1"
API_CONTAINER="jarvis-api-1"

cleanup() {
  docker exec "${PG_CONTAINER}" psql -U jarvis -d postgres \
    -c "DROP DATABASE IF EXISTS ${DRILL_DB}" >/dev/null 2>&1 || true
  docker exec "${API_CONTAINER}" rm -f /tmp/canary-check.mjs >/dev/null 2>&1 || true
  rm -rf "${TARGET}"
}
trap cleanup EXIT

install -d -m 0700 "${DRILL_ROOT}"
install -d -m 0700 "${TARGET}"

echo "--- restoring latest snapshot into ${TARGET}"
restic restore latest --target "${TARGET}" >/dev/null

RESTORED_KEY="${TARGET}/var/lib/jarvis/keys/master.key"
[[ -s "${RESTORED_KEY}" ]] || { echo "FAIL master.key not in the snapshot" >&2; exit 1; }

DUMP="$(find "${TARGET}/var/lib/jarvis/db-backup" -name 'pg-*.dump' -type f 2>/dev/null | sort | tail -1)"
if [[ -z "${DUMP}" ]]; then
  echo "FAIL no database dump in the snapshot — this backup cannot restore Jarvis" >&2
  exit 1
fi
DUMP_BYTES="$(stat -c '%s' "${DUMP}")"
SNAP_NAME="$(basename "${DUMP}")"
CANARY_OK=0
echo "--- dump found: ${SNAP_NAME} (${DUMP_BYTES} bytes)"

echo "--- loading into throwaway database ${DRILL_DB}"
docker exec "${PG_CONTAINER}" psql -U jarvis -d postgres \
  -c "DROP DATABASE IF EXISTS ${DRILL_DB}" >/dev/null
docker exec "${PG_CONTAINER}" psql -U jarvis -d postgres \
  -c "CREATE DATABASE ${DRILL_DB}" >/dev/null
docker cp "${DUMP}" "${PG_CONTAINER}:/tmp/drill.dump" >/dev/null

fail=0
# The restore's own exit status is part of the drill. This step used to end in
# `|| true`: a restore that half-failed still reported every table it happened
# to look at as fine, so the drill could pass on a backup that cannot actually
# bring Jarvis back. The output is printed rather than swallowed, because a
# suppressed message from a step whose success is being assumed is how hours
# disappear (DEBUG_NOTES, "Backups and deploys").
RESTORE_LOG="$(mktemp)"
if ! docker exec "${PG_CONTAINER}" pg_restore -U jarvis -d "${DRILL_DB}" \
       --no-owner /tmp/drill.dump >"${RESTORE_LOG}" 2>&1; then
  echo "  FAIL pg_restore reported errors:"
  head -20 "${RESTORE_LOG}" | sed 's/^/    /'
  fail=1
fi
rm -f "${RESTORE_LOG}"
docker exec "${PG_CONTAINER}" rm -f /tmp/drill.dump >/dev/null 2>&1 || true
check_rows() {
  local table="$1" min="$2"
  local n
  n=$(docker exec "${PG_CONTAINER}" psql -U jarvis -d "${DRILL_DB}" -t -A \
        -c "SELECT count(*) FROM ${table}" 2>/dev/null || echo 0)
  if [[ "${n}" -ge "${min}" ]]; then
    printf '  ok   %-18s %s rows\n' "${table}" "${n}"
  else
    printf '  FAIL %-18s %s rows (expected >= %s)\n' "${table}" "${n}" "${min}"
    fail=1
  fi
}

psql_drill() {
  docker exec "${PG_CONTAINER}" psql -U jarvis -d "${DRILL_DB}" -t -A -c "$1" 2>/dev/null || echo 0
}

# Some tables cannot be judged against a fixed minimum, because how many rows
# they should hold depends on what this box has been asked to remember. They are
# compared against the LIVE database instead, so the check never cries wolf on a
# box that genuinely has an empty corpus and never passes quietly on one whose
# corpus did not make it into the backup.
check_like_live() {
  local table="$1" live back
  live=$(docker exec "${PG_CONTAINER}" psql -U jarvis -d jarvis -t -A \
           -c "SELECT count(*) FROM ${table}" 2>/dev/null || echo 0)
  back=$(psql_drill "SELECT count(*) FROM ${table}")
  if [[ "${live}" -eq 0 ]]; then
    printf '  ok   %-18s nothing live to restore\n' "${table}"
  elif [[ "${back}" -eq 0 ]]; then
    printf '  FAIL %-18s %s rows live, none restored - not in this backup\n' "${table}" "${live}"
    fail=1
  else
    printf '  ok   %-18s %s rows restored (%s live)\n' "${table}" "${back}" "${live}"
  fi
}

echo "--- asserting restored content"
check_rows projects 2
check_rows conversations 1
check_rows tasks 1
check_rows issues 1
check_rows schedules 5
check_rows model_registry 3
check_rows credentials 1
check_rows dek_keys 1
check_rows config_versions 0
check_rows audit_events 1

# S30. Everything Jarvis was told and everything it was given to read lives in
# these two tables, and until now the drill did not look at either: a backup
# that restored the queue and lost the corpus reported "restore-drill ok".
check_like_live knowledge_chunks
check_like_live memory_items

# A row count is not enough for this one table. `knowledge_chunks.search` is a
# GENERATED column (migration 039), so the dump carries the expression and not
# the values and every tsvector is recomputed by the restore. The rows can come
# back complete while the thing that makes them findable comes back empty - and
# from the outside that is indistinguishable from a corpus with nothing to say,
# because retrieval returns nothing and the answer is an honest "I don't know".
# Measured: with the vectors blanked, the count assertion passes and every
# question fails.
BLANK=$(psql_drill "SELECT count(*) FROM knowledge_chunks WHERE search IS NULL OR search = ''::tsvector")
if [[ "${BLANK}" -eq 0 ]]; then
  printf '  ok   %-18s every restored chunk has a tsvector\n' 'chunk index'
else
  printf '  FAIL %-18s %s restored chunks can never be retrieved\n' 'chunk index' "${BLANK}"
  fail=1
fi

# The point of the drill: a restored credential must actually decrypt with the
# restored master key. Fingerprints are compared; plaintext is never printed.
echo "--- decrypting a canary credential with the restored key"
CANARY_ROW=$(docker exec "${PG_CONTAINER}" psql -U jarvis -d "${DRILL_DB}" -t -A -F'|' -c \
  "SELECT c.id, c.fingerprint, encode(d.wrapped_key,'hex'), encode(c.nonce,'hex'), encode(c.ciphertext,'hex')
   FROM credentials c JOIN dek_keys d ON d.id = c.dek_id
   ORDER BY c.id LIMIT 1" 2>/dev/null || true)

if [[ -z "${CANARY_ROW}" ]]; then
  echo "  FAIL no credential rows restored"
  fail=1
else
  cat > /tmp/canary-check.mjs <<'JS'
import fs from "node:fs";
// hex, not base64: Postgres encode(...,'base64') wraps at 76 chars and the
// newlines corrupt the value on the way through psql.
const [, , keyPath, wrappedHex, nonceHex, cipherHex, expectFp] = process.argv;
const { decryptGcm, unwrapDek } = await import("/app/dist/crypto.js");
const master = fs.readFileSync(keyPath);
const dek = unwrapDek(master, Buffer.from(wrappedHex, "hex"));
const plain = decryptGcm(dek, Buffer.from(nonceHex, "hex"), Buffer.from(cipherHex, "hex"));
const payload = JSON.parse(plain.toString("utf8"));
const keys = Object.keys(payload).sort().join(",");
// Never print the value. Prove only that it decrypted and is shaped correctly.
console.log(JSON.stringify({ decrypted: true, fields: keys, fingerprint: expectFp }));
JS
  IFS='|' read -r _cid CFP CWRAP CNONCE CCIPHER <<< "${CANARY_ROW}"
  docker cp /tmp/canary-check.mjs "${API_CONTAINER}:/tmp/canary-check.mjs" >/dev/null
  docker cp "${RESTORED_KEY}" "${API_CONTAINER}:/tmp/restored-master.key" >/dev/null
  if OUT=$(docker exec -w /app "${API_CONTAINER}" node /tmp/canary-check.mjs \
             /tmp/restored-master.key "${CWRAP}" "${CNONCE}" "${CCIPHER}" "${CFP}" 2>&1); then
    CANARY_OK=1
    echo "  ok   canary credential decrypted: ${OUT}"
  else
    echo "  FAIL canary credential did not decrypt: ${OUT}"
    fail=1
  fi
  docker exec "${API_CONTAINER}" rm -f /tmp/restored-master.key /tmp/canary-check.mjs >/dev/null 2>&1 || true
  rm -f /tmp/canary-check.mjs
fi

# Report the outcome to Jarvis over the HMAC-only internal path so the console
# shows it. A drill whose result only lands in a log file teaches nobody.
report() {
  local ok="$1" detail="$2"
  local secret body sig
  secret="$(grep -E '^INTERNAL_HMAC=' /etc/jarvis/compose.env 2>/dev/null | cut -d= -f2-)"
  [[ -n "${secret}" ]] || return 0
  body="$(python3 -c '
import json, sys
print(json.dumps({
    "ok": sys.argv[1] == "1",
    "snapshot": sys.argv[2],
    "dump_bytes": int(sys.argv[3]),
    "canary_decrypted": sys.argv[4] == "1",
    "detail": sys.argv[5],
}, separators=(",", ":")))
' "${ok}" "${SNAP_NAME}" "${DUMP_BYTES}" "${CANARY_OK}" "${detail}")"
  sig="$(printf '%s' "${body}" | openssl dgst -sha256 -hmac "${secret}" -hex | awk '{print $NF}')"
  curl -s -X POST http://127.0.0.1:8080/internal/maintenance/restore-drill     -H "Content-Type: application/json"     -H "X-Jarvis-Internal: ${sig}"     --data "${body}" >/dev/null 2>&1 || true
}

if [[ "${fail}" -ne 0 ]]; then
  report 0 "one or more restore checks failed"
  echo "restore-drill FAILED"
  exit 1
fi
report 1 "all checks passed"
echo "restore-drill ok"

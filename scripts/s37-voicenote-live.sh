#!/usr/bin/env bash
#
# S37 item 5 - a voice note becomes words, and the words are treated as typed.
#
# Runs ON the box, against the live ingest endpoint, because that is what
# Enrique asked for: everything except pairing is testable by posting payloads
# at /internal/inbox/ingest, which needs no phone number.
#
# The fixture is Jarvis speaking a line from its own bank ("Nearly there."), so
# the expected transcript is known rather than guessed, and the assertion is on
# CONTENT - a test that only checks a row appeared would pass on silence.
set -uo pipefail

HMAC=$(sudo grep -oP '(?<=^INTERNAL_HMAC=).*' /etc/jarvis/compose.env)
FIXTURE=${FIXTURE:-/var/lib/jarvis/artifacts/phone/d829fb6e2d0aaf30474165f05377e002.wav}
fails=0
ok()   { echo "  ok   - $1"; }
bad()  { echo "  FAIL - $1"; fails=$((fails+1)); }
psql() { sudo docker exec jarvis-postgres-1 psql -U jarvis -d jarvis -tAc "$1"; }

post() {
  local body="$1"
  local sig
  sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$HMAC" | awk '{print $2}')
  curl -s --max-time 120 -X POST http://127.0.0.1:8080/internal/inbox/ingest \
    -H 'Content-Type: application/json' \
    -H "X-Jarvis-Internal: $sig" \
    -H "X-Request-Id: vn-$RANDOM-$RANDOM" \
    -d "$body"
}

B64=$(sudo base64 -w0 "$FIXTURE")
echo "fixture $(basename "$FIXTURE"), $(echo -n "$B64" | wc -c) base64 chars"

echo "1. a spoken message arrives as text"
EXT="vn-spoken-$RANDOM"
R=$(post "{\"channel\":\"whatsapp\",\"external_id\":\"$EXT\",\"sender\":\"+13055052646\",\"audio_base64\":\"$B64\",\"audio_mime\":\"audio/wav\"}")
echo "    response: $(echo "$R" | head -c 120)"
RAW=$(psql "SELECT raw_text FROM inbox_events WHERE external_id = '$EXT'")
case "$RAW" in
  *"Nearly there"*) ok "transcript stored as the message body: $RAW";;
  "")               bad "no inbox event was created";;
  *)                bad "unexpected body: $RAW";;
esac

echo "2. the audio is kept as raw_audio, on the same clock as call audio"
A=$(psql "SELECT a.retention_class || '|' || a.source || '|' || (a.retain_until::date - now()::date) || '|' || (a.inbox_event_id IS NOT NULL)
          FROM artifacts a JOIN inbox_events e ON e.id = a.inbox_event_id WHERE e.external_id = '$EXT'")
IFS='|' read -r cls src days linked <<< "$A"
[ "$cls" = "raw_audio" ] && ok "retention_class=raw_audio" || bad "retention_class=$cls"
[ "$src" = "whatsapp" ] && ok "source=whatsapp" || bad "source=$src"
[ "$days" = "7" ] && ok "expires in 7 days" || bad "retain_until is $days days out"
[ "$linked" = "true" ] && ok "linked to the message it became" || bad "artifact not linked to the inbox event"

echo "3. it is routed like typed text, not parked in a side channel"
ST=$(psql "SELECT processing_state FROM inbox_events WHERE external_id = '$EXT'")
[ -n "$ST" ] && [ "$ST" != "pending" ] && ok "processing_state=$ST" || bad "processing_state=$ST (never routed)"

echo "4. a FORWARDED voice note is somebody else's words"
EXT2="vn-fwd-$RANDOM"
post "{\"channel\":\"whatsapp\",\"external_id\":\"$EXT2\",\"sender\":\"+13055052646\",\"audio_base64\":\"$B64\",\"audio_mime\":\"audio/wav\",\"is_forward\":true}" >/dev/null
OWNED=$(psql "SELECT coalesce(raw_text,'') FROM inbox_events WHERE external_id = '$EXT2'")
FWD=$(psql "SELECT coalesce(forwarded_text,'') FROM inbox_events WHERE external_id = '$EXT2'")
case "$FWD" in *"Nearly there"*) ok "transcript filed as forwarded content";; *) bad "forwarded_text=$FWD";; esac
case "$OWNED" in *"Nearly there"*) bad "a forwarded voice note was recorded as HIS words";; *) ok "not attributed to him";; esac

echo "5. audio that cannot be transcribed still keeps the audio"
EXT3="vn-bad-$RANDOM"
GARBAGE=$(head -c 600 /dev/urandom | base64 -w0)
post "{\"channel\":\"whatsapp\",\"external_id\":\"$EXT3\",\"sender\":\"+13055052646\",\"audio_base64\":\"$GARBAGE\",\"audio_mime\":\"audio/ogg\"}" >/dev/null
BODY=$(psql "SELECT coalesce(raw_text,'') FROM inbox_events WHERE external_id = '$EXT3'")
KEPT=$(psql "SELECT count(*) FROM artifacts a JOIN inbox_events e ON e.id = a.inbox_event_id WHERE e.external_id = '$EXT3' AND a.retention_class = 'raw_audio'")
case "$BODY" in *"could not be transcribed"*) ok "the failure is stated, not swallowed";; *) bad "body=$BODY";; esac
[ "$KEPT" = "1" ] && ok "the recording is kept so it can be retried" || bad "no artifact kept ($KEPT)"

echo
[ "$fails" -eq 0 ] && echo "S37 voice notes PASS" || echo "S37 voice notes FAIL ($fails)"
exit "$fails"

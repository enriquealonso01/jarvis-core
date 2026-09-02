#!/usr/bin/env bash
# The build bar's state: one source, correctly labelled, and honest when absent.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
COMPOSE="docker compose -f deploy/compose.dev.yaml"

a=$(node scripts/progress-endpoint-test.mjs 2>&1); echo "$a"

# The absent case, forced rather than imagined: take the file away underneath a
# running API. Serving `{}` here would draw a plausible empty build; the bar has
# no way to tell that apart from a real one, so the endpoint must refuse.
echo
echo "########## the file is gone: say so, do not invent a build ##########"
echo
pass2=0; fail2=0
$COMPOSE exec -T api mv /app/PROGRESS.json /app/PROGRESS.json.hidden >/dev/null 2>&1
# Body and status from one request, with no temp file: this runs under Git Bash
# against a Windows curl, which does not resolve `/tmp` the way the shell does.
resp=$(curl -s -w $'\n%{http_code}' http://127.0.0.1:8080/PROGRESS.json)
code=$(printf '%s' "$resp" | tail -1)
body=$(printf '%s' "$resp" | sed '$d')
$COMPOSE exec -T api mv /app/PROGRESS.json.hidden /app/PROGRESS.json >/dev/null 2>&1

if [ "$code" = "503" ]; then echo "  PASS  it answers 503, not 200"; pass2=$((pass2+1));
else echo "  FAIL  it answers 503, not 200"; echo "        actual:   $code"; fail2=$((fail2+1)); fi

if printf '%s' "$body" | grep -q 'progress_unavailable'; then
  echo "  PASS  naming the reason"; pass2=$((pass2+1));
else echo "  FAIL  naming the reason"; echo "        actual:   ${body:0:120}"; fail2=$((fail2+1)); fi

# And it comes back on its own once the file returns — no restart.
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/PROGRESS.json)
if [ "$code" = "200" ]; then echo "  PASS  and recovers by itself when the file returns"; pass2=$((pass2+1));
else echo "  FAIL  and recovers by itself when the file returns"; echo "        actual:   $code"; fail2=$((fail2+1)); fi

ap=$(printf '%s' "$a" | grep -oE '==== [0-9]+ passed' | grep -oE '[0-9]+')
af=$(printf '%s' "$a" | grep -oE '[0-9]+ failed' | tail -1 | grep -oE '[0-9]+')
echo
echo "==== $(( ${ap:-0} + pass2 )) passed, $(( ${af:-1} + fail2 )) failed ===="
[ "$(( ${af:-1} + fail2 ))" -eq 0 ]

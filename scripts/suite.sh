#!/usr/bin/env bash
#
# Run one dev suite against source that is actually current.
#
# The suites run inside the `runner` image, which snapshots src/ and scripts/ at
# build time. Editing a file and running its suite therefore tests the PREVIOUS
# code, silently and with a plausible result. That cost four wrong answers on
# 2026-09-03, and one false claim: a fix of mine removed a deliberate feature,
# the suite reported 27/0 because the image predated the change, and "27/0
# before and after" went into a pull request and into VERIFIED.md.
#
# sweep.sh already avoids this by rebuilding first. This is the same guarantee
# for a single suite, because the failure only happens when running one.
#
#   scripts/suite.sh s41-voicerecall-test
#   scripts/suite.sh s41-voicerecall-test s38-brevity-test
#
# It rebuilds only when the tree is newer than the image, so the common case
# costs one `docker image inspect`.
set -uo pipefail
cd "$(dirname "$0")/.."

[ "$#" -gt 0 ] || { echo "usage: scripts/suite.sh <suite-name> [suite-name...]" >&2; exit 2; }

COMPOSE="docker compose -f deploy/compose.dev.yaml"

# Say WHICH MACHINE this is about to test on.
#
# This script was written to stop a suite running against stale code, and it
# does. It said nothing about staleness of PLACE, which is the other half and
# reads identically in the output: `compose.dev.yaml` runs against whatever the
# local docker context points at, and on this workstation that is Docker
# Desktop. A green suite there is a local fixture — the exact thing the standing
# brief says never to call verified.
#
# So the endpoint is printed on every run rather than checked, because there is
# no correct answer to enforce: the dev stack running locally is *useful*, it is
# just not proof. Printing it costs one line and makes the distinction
# impossible to forget while reading a result.
ENDPOINT=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || echo unknown)
case "$ENDPOINT" in
  ssh://*|tcp://*) echo "==> suite runs against $ENDPOINT" ;;
  *) echo "==> suite runs LOCALLY ($ENDPOINT) — a green result here is a fixture, not the box" ;;
esac

# Always rebuild, rather than rebuilding when the tree looks newer.
#
# The first version of this compared source mtimes against the image's Created
# timestamp, and it was wrong: with layer caching Docker reuses the existing
# image and Created does not advance, so a "current" image can be arbitrarily
# old. A freshness check that reports stale when it is fresh is merely annoying;
# one that reports fresh when it is stale is the exact failure this script
# exists to stop, and it would be silent.
#
# An unchanged rebuild is a few seconds of cache checks, which is cheap against
# the cost of testing code you did not write.
# The API too, not only the runner.
#
# This script's guarantee was half a guarantee. Suites run inside the `runner`
# image, so that is what it rebuilt - but a good number of them reach the API
# over HTTP, and the API is a different image. progress-endpoint-test compares
# what `/PROGRESS.json` serves against the file on disk; the API serves the copy
# baked into ITS image, so the suite failed 12/1 against an API built before the
# file changed. Rebuilding the runner and re-running changed nothing, which is
# what made it look like a product bug rather than a stale image - the fourth
# time in this loop that staleness has been mistaken for a failure, and the
# first where this script was the thing giving false assurance.
#
# `dev-rebuild.sh` is used rather than a bare `build` because the API has to be
# RESTARTED to serve the new image; building it and leaving the old container up
# would be a more convincing version of the same lie.
echo "==> rebuilding the api and runner images so the suite reads current source"
bash scripts/dev-rebuild.sh api runner >/dev/null 2>&1 || {
  echo "the rebuild failed; refusing to run a suite against stale code" >&2; exit 1; }

status=0
for suite in "$@"; do
  printf '\n##### %s #####\n' "$suite"
  if [ -f "scripts/$suite.sh" ]; then
    bash "scripts/$suite.sh" || status=1
  else
    echo "no such suite: scripts/$suite.sh" >&2; status=1
  fi
done
exit "$status"

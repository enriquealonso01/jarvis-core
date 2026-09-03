#!/usr/bin/env bash
# S31 — a hostile MCP server in a real container.
#
# Runs on the HOST, not through `docker compose run`: it needs the Docker
# daemon to start the sandboxed server, so it is the compose wrapper's peer
# rather than its child. The database is reached on the published dev port.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS2_ARG_CONV_EXCL='*'
export MSYS_NO_PATHCONV=1
export DATABASE_URL="${DATABASE_URL:-postgres://jarvis:dev@127.0.0.1:55432/jarvis}"
node --import tsx scripts/s31-mcp-test.ts 2>&1

#!/bin/bash
# Pull OpenClaw image. Do not start until dedicated WhatsApp + QR (Phase 2).
set -euo pipefail
docker pull ghcr.io/openclaw/openclaw:latest
mkdir -p /var/lib/jarvis/openclaw
chown jarvis:jarvis /var/lib/jarvis/openclaw
chmod 750 /var/lib/jarvis/openclaw
echo "Image pulled. Pair WhatsApp over SSH, then:"
echo "  docker compose -f /opt/jarvis/deploy/compose.yaml --profile openclaw up -d"
echo "  docker compose -f /opt/jarvis/deploy/compose.yaml run --rm openclaw-cli channels login"
echo "Plugin path: /opt/jarvis/core/packages/openclaw-jarvis-bridge"

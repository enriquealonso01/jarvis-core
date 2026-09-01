# ADR 009 — Network exposure

- Status: accepted
- Date: 2026-08-31
- Plan sections: §18, §49–50, §65, OpenClaw voice-call (public webhook)
- Affects isolation / billing / always-confirm: no

## Decision

**Public internet (Caddy :443):**

- Control Center static + Jarvis API (ADR 004)
- `POST /webhooks/telnyx` with Telnyx signature verification (and replay window)
- Redirect HTTP → HTTPS

**Not public:**

- OpenClaw Gateway (listen `127.0.0.1` + Tailscale interface only)
- Postgres
- Docker socket
- SSH (Tailscale and/or allowlisted IP; keys only)
- Internal ingest `/internal/*` (localhost only)

WhatsApp Baileys is outbound WebSocket. No public WhatsApp webhook.

Telnyx requires a reachable webhook. That is **Jarvis API**, not the OpenClaw admin UI. OpenClaw voice-call plugin may bind localhost; Caddy forwards only the signed path to the process that verifies signatures. If the plugin insists on its own port, Caddy reverse-proxies that path only, still with signature verification enabled in the plugin.

Firewall: default deny. Allow 80/443, Tailscale, established.

## Why

Plan says OpenClaw admin is not public, and Telnyx needs a public webhook. Both are true; they are different URLs.

## Alternatives rejected

- **Tailscale Funnel for Telnyx** — extra moving part; Caddy path is enough.
- **Expose OpenClaw Gateway for “simplicity”** — forbidden §50.

## Consequences

- Phase 0: Tailscale on the Netcup box, Enrique’s devices on the tailnet.
- Health check “OpenClaw reachable” is from the API container via localhost, not from the internet.
- **Rollback:** exposing the OpenClaw Gateway or Postgres publicly is a one-line Caddy change and an unbounded attack-surface increase. Narrowing exposure further (dropping the Telnyx webhook) is always safe and only costs inbound call handling.

## User approval required

No.

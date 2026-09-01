# Acceptance Test Report — 2026-08-31
Target: `https://jarvis.enriquecodes.com`
Operator: `alonsorequejoenrique@gmail.com`

| Test | Loop | Status | Details |
|---|---|---|---|
| Operator Login | `AUTH` | **PASS** | status=200 |
| UI Security & Origin Check | `L16` | **PASS** | unauth_status=401, bad_origin_status=403 |
| First-run Chat & Project Onboarding | `L0` | **PASS** | chat_ok=True, proj_ok=True, slug=proj-accept-1788215224 |
| Inbox Persist-First | `L1` | **PASS** | found 12 events, persisted state confirmed |
| Always-Confirm Broker Deny | `L8` | **PASS** | status=403, res={'error': {'code': 'broker_deny', 'message': 'Always-confirm action needs a live approval.'}} |
| Quiet Hours Gate & Webhook Ingest | `L13` | **PASS** | status=200, response={'ok': True} |
| Schedules Registry | `L14` | **PASS** | registered=5 schedules (Improvement & Maintenance) |
| Connections Verification | `CONN` | **PASS** | active credentials: backup_b2, elevenlabs, github_personal_admin, google_ai, groq, nvidia |
| Model Registry | `MODELS` | **PASS** | registered=5 models across providers |

## Summary
- Total Tests: 9
- Passed: 9
- Failed: 0

## Missing / Deferred Capabilities (Blocked on Operator Keys / Logins)
- Anthropic / Codex / Cursor host login sessions on VPS (`harness` heavy lane)
- WhatsApp dedicated number & QR pairing (OpenClaw channel)
- Telnyx E.164 numbers & ElevenLabs voice_id in site.yaml
- Netcup SCP OAuth refresh token
# OpenClaw integration

Companion to ADR 001–002 and 006.

## jarvis-bridge plugin

Installed into OpenClaw as a local plugin from `/opt/jarvis/core/packages/openclaw-jarvis-bridge`.

**On inbound message (WhatsApp, and any other channel we enable):**

1. Build a canonical payload: channel, external_id, sender, timestamp, text, media refs.
2. HMAC POST `http://127.0.0.1:8080/internal/inbox/ingest`.
3. On 2xx: do not run the default agent completion.
4. On 5xx/timeout: retry 5 times; never LLM-complete.
5. Jarvis later `openclaw message send` (exact RPC name as current docs at implement time).

**Disable** OpenClaw auto-reply / default agent tools for user DMs except what the bridge needs to ack at the transport layer.

## Session mapping

WhatsApp DM from the owner collapses to Supervisor conversation **routing**, not one global OpenClaw “main session owns all projects.” Postgres `conversations` are per project. OpenClaw session id stored on the conversation or task `external_session_id` when a live runtime exists.

Do not use OpenClaw `session.dmScope=main` as the product conversation model. If OpenClaw requires a main session, treat it as a pipe, not memory.

## Automations

Sync worker:

- Desired = `schedules` where not paused
- Actual = OpenClaw automation list
- Upsert by `openclaw_automation_id` / name prefix `jarvis:<schedule_uuid>`
- Fire webhook → `/internal/schedules/fire` with schedule id + `scheduled_for` for idempotency

## ACP

Prefer Jarvis-spawned harness (ADR 006). If using OpenClaw ACP:

- Pass cwd = worktree
- Pass isolated config dir per **auth profile**
- Abort if plugin would inherit default host `~/.claude` for a project that has its own profile

Record OpenClaw background task id on `tasks.external_session_id`.

## Voice-call plugin

Config: Telnyx + ElevenLabs SecretRefs pointing at files Jarvis manages, or env from API process — **not** Control Center. Public URL: `https://jarvis.<domain>/webhooks/telnyx`. Quiet hours enforced in **Jarvis** before placing outbound (`telnyx.quiet_hours` error class).

Inbound: transcript + recording artifact → ingest as channel `phone`.

## Health

API polls OpenClaw heartbeat. Down > 1 min → Issue `openclaw.down` + WhatsApp if also API still up (outbox). If both down, user notices from Tailscale/Caddy; on recovery, reconcile Inbox from OpenClaw message log.

## What we will not duplicate

Baileys reconnect, QR login, ACP process supervision internals, Telnyx media streaming, OpenClaw sandbox Docker backend **when we can pass our mounts**. We **will** duplicate (in Postgres) product history the Control Center needs.

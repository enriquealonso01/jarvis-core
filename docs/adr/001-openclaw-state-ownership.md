# ADR 001 — OpenClaw state ownership and inbound persist-first

- Status: accepted
- Date: 2026-08-31
- Plan sections: §3, §6, §14, §26
- Affects isolation / billing / always-confirm: no (mechanics only)

## Decision

**PostgreSQL is the only long-term product source of truth.** OpenClaw is the runtime for channels, live sessions, native automations, low-level provider token refresh, ACP/coding processes, and voice media.

Jarvis API is the only writer of product tables. OpenClaw never connects to Postgres.

Write-leaders:

| Concern | Leader | Follower |
|---|---|---|
| Inbox, conversations, tasks, queue, issues, approvals, grants | Postgres | OpenClaw has no copy that counts |
| Projects, connections metadata, auth-profile policy | Postgres | OpenClaw receives only the runtime subset it needs |
| Audit, artifacts index, model registry, outbox | Postgres | — |
| Live WhatsApp socket, QR session, Baileys creds | OpenClaw | Jarvis stores health + last-event cursor |
| In-flight ACP/coding/browser OS processes | OpenClaw or Jarvis worker supervisor | Postgres stores task + external_session_id |
| Cron fire (clock) | OpenClaw automations | Postgres `schedules` is canonical config; OpenClaw is the executor |
| OAuth refresh for harness/provider logins | Files under `/var/lib/jarvis/harness-auth/<profile>/` plus OpenClaw auth store where required | Postgres stores profile metadata and health, never refresh tokens in plaintext |
| Voice-call media path | OpenClaw voice-call plugin + Telnyx | Postgres stores Inbox Event + transcript + artifact ids |

**Inbound path (normative):**

1. Channel delivers to OpenClaw (WhatsApp, voice plugin, etc.).
2. The `jarvis-bridge` OpenClaw plugin POSTs the raw event to Jarvis `POST /internal/inbox/ingest` on localhost.
3. Jarvis writes the Inbox Event (or dedupes) and returns 2xx **before** any model is called.
4. The plugin does **not** invoke the default OpenClaw agent reply.
5. Jarvis enqueues classification/routing on the Supervisor lane.
6. If Jarvis later needs a WhatsApp send, it calls OpenClaw send RPC. Outbound also writes the notification outbox first.

If ingest returns 5xx or times out: the plugin does not run a model. It retries ingest. OpenClaw still has the native message. Jarvis reconciliation (startup + every 30s) lists recent OpenClaw inbound messages and inserts any missing Inbox Events by external id.

**Schedules:**

- Create/update/delete happens in Postgres via API/UI/natural-language config tasks.
- A sync worker upserts the matching OpenClaw automation and stores `openclaw_automation_id`.
- On fire, OpenClaw calls Jarvis `POST /internal/schedules/fire`. Jarvis writes Inbox Event `source=schedule` and a task.
- Reconciliation: if Postgres has a row OpenClaw lacks, recreate. If OpenClaw has an automation Postgres does not, disable it and open an Issue (`config_drift`).
- Overlap/misfire policy is enforced by Jarvis when handling `/fire`, not by hoping OpenClaw and Jarvis both decide.

**Linking:** every OpenClaw session, automation, and background task Jarvis uses has `external_id` columns on the Postgres entity. Format: `openclaw:<kind>:<id>`.

## Why

The frozen plan requires both “do not duplicate OpenClaw” and “OpenClaw history is not sufficient product history.” Without a write-leader, implementation will dual-write and lose tasks on restart.

## Alternatives rejected

- **OpenClaw as only store** — violates §6.2 and audit/Control Center needs.
- **Postgres as runtime for WhatsApp** — would reimplement Baileys; forbidden by §3.
- **Default OpenClaw agent as the brain, Jarvis as a logger** — cannot enforce project policy, auth-profile routing, or persist-before-model.

## Consequences

- Implementation must ship `jarvis-bridge` before WhatsApp is “done.”
- OpenClaw main agent must not auto-complete user work.
- Reconciliation is a first-class system-lane job, not an afterthought.
- Internal ingest binds to `127.0.0.1` (and Tailscale only if explicitly needed for debug), HMAC-authenticated.

## User approval required

No. This is the mechanics the plan implied.

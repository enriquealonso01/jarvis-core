# HTTP API and events

Base: `https://jarvis.<domain>/api`. JSON. Session cookie (ADR 004). Internal routes not on public Caddy.

## Public/auth

| method | path | notes |
|---|---|---|
| POST | /api/auth/login | email, password; sets cookie |
| POST | /api/auth/logout | |
| GET | /api/me | |

## Inbox / conversations / work

| method | path |
|---|---|
| GET | /api/inbox?state= |
| GET | /api/inbox/:id |
| POST | /api/inbox/:id/reroute {project_id} |
| GET | /api/conversations |
| GET | /api/conversations/:id |
| POST | /api/conversations/:id/messages | UI compose → ingest |
| GET | /api/tasks |
| GET | /api/tasks/:id |
| POST | /api/tasks/:id/pause\|resume\|cancel\|reprioritize |
| GET | /api/queue |
| GET | /api/projects |
| GET | /api/projects/:id |
| POST | /api/projects | onboarding |
| PATCH | /api/projects/:id |
| GET | /api/issues |
| POST | /api/issues/:id/ignore {reason} |
| GET | /api/approvals |
| POST | /api/approvals/:id/decide {approved} |
| GET | /api/action-requests/:id | cookie or ?t= |
| POST | /api/action-requests/:id/submit | secrets |
| GET | /api/connections |
| POST | /api/connections/:id/test |
| GET | /api/schedules |
| PUT | /api/schedules/:id |
| GET | /api/models |
| GET | /api/artifacts/:id | stream; project-scoped auth |
| GET | /api/health |
| GET | /api/audit?project_id=&from= |
| GET | /api/config-versions |
| GET | /api/events | SSE |

UI compose and file upload use `POST /api/inbox` with multipart; server persists then queues (same as WhatsApp).

## SSE (`GET /api/events`)

After session check, stream `text/event-stream`. Event types:

- `health`
- `task.updated`
- `queue.updated`
- `issue.updated`
- `approval.updated`
- `conversation.message`
- `heartbeat` (15s)

If client silent > 5s of heartbeats missed, UI stale banner. No chain-of-thought; tool names + phase only.

## Internal (127.0.0.1, HMAC header `X-Jarvis-Internal`)

| method | path | notes |
|---|---|---|
| POST | /internal/inbox/ingest | OpenClaw bridge; persist-first |
| POST | /internal/schedules/fire | |
| POST | /internal/workers/heartbeat | |
| POST | /internal/workers/events | tool/progress |
| POST | /internal/telnyx | if not served as /webhooks/telnyx |

`POST /webhooks/telnyx` is public but signature-verified; it writes Inbox and/or passes to OpenClaw plugin as designed in OPENCLAW_INTEGRATION.

## OpenClaw RPC (localhost)

Jarvis calls Gateway: send WhatsApp, spawn ACP (if used), list sessions, list automations, upsert automation. Token only in API env `OPENCLAW_GATEWAY_TOKEN`, never to browser.

## Errors

`{ "error": { "code": "broker_deny", "message": "...", "issue_id": "..." } }`  
No stack traces to UI. Correlation id header `X-Request-Id`.

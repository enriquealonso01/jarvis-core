# Control Center mapping

Repo: `jarvis-control-center`. Next.js/React. Production served by Caddy (ADR 004). No sci-fi chrome. No fake %.

Auth: cookie against `/api`. Preview: see ADR 004.

## Navigation (plan §38)

Desktop sidebar; mobile bottom: Home, Work, Conversations, Issues, More.

| Route | Primary APIs |
|---|---|
| / | GET /health, /queue, /tasks?running, /issues?open, /projects, /schedules; **global Supervisor chat** |
| /projects | GET /projects |
| /projects/[id] | tabs: overview, work, conversations, activity, repository, artifacts, memory, connections, schedules, issues, settings |
| /work | GET /tasks, SSE task.updated |
| /queue | GET /queue |
| /conversations | GET /conversations — includes unscoped (global) thread |
| /operations | GET /health + issues |
| /issues | GET /issues |
| /approvals | GET /approvals |
| /connections | GET /connections |
| /schedules | GET /schedules |
| /models | GET /models |
| /artifacts | GET project artifacts |
| /improvement | tasks+issues for jarvis-improvement |
| /maintenance | same for maintenance + disk/RAM |
| /settings | audit, config versions, user |

## Command Center widgets (§39)

Bind to real fields only. If a metric is unknown, show `unknown` (stale/unknown), never 0 pretending healthy.

**First-run:** Home is a **provider checklist** for every bootstrap profile (`docs/INITIAL_MODEL_ROUTING.md`). The composer stays disabled until the Supervisor route is healthy. Then paste documentation and create projects. Projects list may contain only Improvement and Maintenance until you create more.

## Work detail (§41)

Objective, phase, model/harness/profile **id**, branch, tool events (SSE), tests, review, artifacts, errors, timers, checkpoints, PR/deploy, linked inbox ids. No hidden CoT.

## Action pages (§12)

`/actions/[id]` — copy from `user_action_requests.payload`. Password fields for secrets. Show privacy/cost. POST submit.

## Live

SSE `/api/events`. Disconnect > 5s: banner “live updates paused.” Reconnect.

## Security

Do not log secrets in the client. Do not put `NEXT_PUBLIC_` provider keys. Artifact download through API.

## PWA

Phase 3: installable, but WhatsApp remains primary pager; PWA is not a second notification science project. Optional web push: **not V1** (not in plan). Do not add it.

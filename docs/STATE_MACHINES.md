# State machines

Illegal transitions are API 409 + audit. Every task/issue/inbox change writes a transition row where specified.

---

## Inbox Event — capture_state

`received` → `persisted` → (terminal)

`received` → `failed_capture` (disk/db write failed; retry ingest; do not model)

## Inbox Event — processing_state

```
pending → classified → routed → processed
pending → ignored          # allowlist / duplicate logical
pending → failed           # Issue created; event remains
classified → routed
routed → processed
any non-terminal → pending # replay after fix
```

`processed` means routing finished (conversation/task/memory created or explicit no-op), not that the heavy task succeeded.

---

## Task

States from plan §23:

```
captured → classified → queued
queued → preparing → running
running → waiting_for_tool → running
running → waiting_for_provider → queued | waiting_for_user
running → waiting_for_user
running → waiting_for_approval
running → paused
running → stalled → recovering
running → retry_scheduled → queued
running → succeeded | failed_terminal | cancelled
preparing → queued | failed_terminal
paused → queued | cancelled
stalled → recovering → queued | running | waiting_for_user
recovering → running | retry_scheduled | failed_terminal | waiting_for_user
waiting_* → queued | running | cancelled | failed_terminal
```

`captured` is created as soon as the router decides this is work. User-visible Work view starts at `queued` or later; `captured/classified` may be sub-second.

Watchdog sets `stalled` then `recovering`. Worker never self-sets `succeeded` without a final checkpoint.

Cancel: user or policy; running worker must observe cancel flag within one heartbeat.

---

## Issue (plan §42)

```
Open → Investigating → Auto-resolving → Resolved
Open → Waiting for Jarvis | Waiting for User | Waiting for Provider
Waiting_* → Investigating | Resolved | Ignored/Suppressed
Auto-resolving → Resolved | Open
```

Dedupe: if an open issue with same `dedupe_key` exists, append `issue_events` and bump `updated_at`; do not insert a second row.

---

## Approval

```
pending → approved → consumed
pending → rejected | expired | invalidated
approved → expired | invalidated   # if SHA changes before consume
```

Consume is the merge/deploy/high-risk call.

---

## Task grant

```
active → consumed | expired | invalidated
```

Invalidation reasons: enumerated in plan §13.2; store in `invalidate_reason`.

---

## Connection

```
pending_user → testing → healthy
testing → failed
healthy → expired | failed | rotating → testing
task_ephemeral: healthy → expired (TTL job)
```

---

## Notification outbox

```
pending → sent
pending → pending  # retry
pending → failed   # after N=8; Issue notification.delivery; do not mark task delivered
```

---

## Schedule

Logical: `active | paused | failed_paused`. Runs have `ok | skipped_overlap | skipped_misfire | error`.

---

## UserActionRequest

```
open → consumed | expired | cancelled
```

Token replay after consumed: 409.

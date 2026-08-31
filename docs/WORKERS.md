# Worker protocol

System and heavy workers are Node processes from the Core image. They authenticate to `/internal/*` with the HMAC key, not the user cookie.

## Claim

```
BEGIN;
SELECT id FROM tasks
 WHERE state = 'queued' AND lane = $lane
   AND (lease_until IS NULL OR lease_until < now())
 ORDER BY
   CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
   created_at
 FOR UPDATE SKIP LOCKED
 LIMIT 1;
-- apply ADR 007 starvation cap in SQL or in the claimer
UPDATE tasks SET state='preparing', lease_owner=$worker_id, lease_until=now()+interval '60s', heartbeat_at=now()
 WHERE id=$id;
COMMIT;
```

## Heartbeat `POST /internal/workers/heartbeat`

```json
{
  "worker_id": "heavy-1",
  "task_id": "uuid",
  "phase": "implement",
  "cpu_busy": true,
  "last_tool": "test",
  "progress_note": "running pytest"
}
```

Missed 90s → watchdog.

## Progress `POST /internal/workers/events`

```json
{
  "task_id": "uuid",
  "type": "tool | test | git | review | log",
  "name": "git.commit",
  "summary": "sha abc123",
  "artifact_id": null
}
```

Persisted and SSE-broadcast. Never include secrets or chain-of-thought.

## Checkpoint payload (JSONB)

Must include plan §25 keys: objective, constraints, user_instructions, project_id, conversation_id, inbox_ids, plan, progress_summary, branch, sha, modified_files, commands_outputs_refs, tests, hypothesis, pending_actions, artifact_ids, grant_id, next_action.

## Cancel

`tasks.cancel_requested_at` set by API. Worker checks each heartbeat; then `cancelled`.

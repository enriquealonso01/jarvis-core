-- S3c: feedback typed while a task is running.
--
-- "Also check whether this could affect the CSV export", sent while the harness
-- is thirty minutes into a run. Killing the run to hand it the sentence throws
-- away the thirty minutes; ignoring the sentence loses his input. So it lands
-- here, and the runner picks it up at its next checkpoint boundary — pulled,
-- never pushed, because a process that is mid-harness-call has nowhere for a
-- push to land.
--
-- Rows survive the run they were meant for. Context that arrives a second after
-- a task finishes is still on the task, still readable, and still says when it
-- arrived: it must be retrievable rather than vanishing into a finished task.

CREATE TABLE task_context (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks (id),
  inbox_event_id uuid REFERENCES inbox_events (id),
  conversation_id uuid REFERENCES conversations (id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set by the runner when the context actually reached the worktree, with the
  -- attempt that saw it. Null means still pending; a pending row on a finished
  -- task is exactly the "arrived too late" case, and is meant to stay visible.
  delivered_at timestamptz,
  delivered_attempt integer,
  -- The state the task was in when the context was attached. Answering "did
  -- this interrupt a run?" later should not require guessing from timestamps.
  attached_state text NOT NULL
);

-- The runner polls this on every heartbeat, so it has to be a cheap index hit.
CREATE INDEX task_context_pending ON task_context (task_id) WHERE delivered_at IS NULL;
CREATE INDEX task_context_task_created ON task_context (task_id, created_at);

-- WORKERS.md: progress events and checkpoints are different things.
--
-- /internal/workers/events was writing into task_checkpoints, so a log line and
-- a resume point were indistinguishable — and the watchdog resumes from "the
-- latest checkpoint", which could be a tool log rather than durable state.
CREATE TABLE IF NOT EXISTS task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks (id),
  at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL CHECK (type IN ('tool', 'test', 'git', 'review', 'log')),
  name text,
  summary text,
  artifact_id uuid REFERENCES artifacts (id)
);

CREATE INDEX IF NOT EXISTS task_events_task_at ON task_events (task_id, at DESC);

-- Live worker status, so the console can show what a task is doing right now
-- without inventing a percentage.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS phase text,
  ADD COLUMN IF NOT EXISTS last_tool text,
  ADD COLUMN IF NOT EXISTS progress_note text;

-- Move anything the events endpoint already put in checkpoints across, so the
-- resume path stops seeing log lines as checkpoints.
INSERT INTO task_events (task_id, at, type, name, summary)
SELECT c.task_id,
       c.at,
       CASE WHEN c.payload->>'type' IN ('tool','test','git','review','log')
            THEN c.payload->>'type' ELSE 'log' END,
       c.payload->>'name',
       c.payload->>'summary'
FROM task_checkpoints c
WHERE c.payload ? 'type' AND c.payload ? 'name';

DELETE FROM task_checkpoints WHERE payload ? 'type' AND payload ? 'name';

-- S18: the two objects the schema is missing, and the indexes search needs.

-- One ordered feed per project and globally.
--
-- `audit_events` answers "who did what to the system"; this answers "what has
-- been happening on Alpha", which is a different question and the one Enrique
-- asks. Keeping them apart matters: an audit trail that is also a activity feed
-- gets filtered for readability, and a filtered audit trail is not one.
CREATE TABLE IF NOT EXISTS activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id),
  at timestamptz NOT NULL DEFAULT now(),
  -- task | artifact | issue | conversation | schedule | project | connection
  kind text NOT NULL,
  -- The row this is about, so the feed can link to the thing itself.
  subject_id uuid,
  title text NOT NULL,
  detail text,
  actor text NOT NULL DEFAULT 'jarvis',
  href text
);
CREATE INDEX IF NOT EXISTS activity_by_project ON activity_events (project_id, at DESC);
CREATE INDEX IF NOT EXISTS activity_global ON activity_events (at DESC);

-- CPU, RAM, disk and I/O over time.
--
-- Host metrics are computed live and thrown away, so the console can say "disk
-- is at 84%" and never "disk has climbed nine points this week" — and
-- Maintenance can only act after a threshold, never before it. A slope needs
-- history; a gauge does not have one.
CREATE TABLE IF NOT EXISTS resource_metrics (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  cpu_busy_pct numeric(5,2),
  memory_used_pct numeric(5,2),
  disk_used_pct numeric(5,2),
  disk_free_bytes bigint,
  load1 numeric(6,2)
);
CREATE INDEX IF NOT EXISTS resource_metrics_at ON resource_metrics (at DESC);

-- Search reads text out of these constantly. Trigram indexes make ILIKE on a
-- large table something other than a sequential scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS messages_body_trgm ON messages USING gin (body gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tasks_title_trgm ON tasks USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS issues_title_trgm ON issues USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS knowledge_body_trgm ON knowledge_chunks USING gin (body gin_trgm_ops);
CREATE INDEX IF NOT EXISTS memory_body_trgm ON memory_items USING gin (body gin_trgm_ops);
CREATE INDEX IF NOT EXISTS inbox_raw_trgm ON inbox_events USING gin (raw_text gin_trgm_ops);

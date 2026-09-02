-- S16: which blocker a parked task is waiting on.
--
-- Gate 4 asks for more than "the issue closed": "expire a GitHub credential ->
-- ONE deduplicated issue, and EVERY AFFECTED TASK LINKS TO IT. Reauthenticating
-- closes the issue and resumes ALL of them, not just the one that hit it first."
--
-- Without this column the only way to release parked work was to requeue
-- everything that happened to be waiting — which resumes tasks blocked on a
-- different credential, a disk that is still full, or a question nobody has
-- answered. The link is what makes "resume all of them" mean the right ones.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocked_by_issue_id uuid REFERENCES issues(id);

CREATE INDEX IF NOT EXISTS tasks_blocked_by
  ON tasks (blocked_by_issue_id) WHERE blocked_by_issue_id IS NOT NULL;

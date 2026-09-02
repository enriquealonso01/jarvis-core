-- S10: natural-language grants, and the one thing they can never buy.
--
-- A grant pre-authorises Level 1 and Level 2 actions for one task, one
-- repository, one commit and one environment. Level 3 — production — is never
-- reachable this way, and this column is the per-project switch that says so out
-- loud rather than leaving it implicit in code.
--
-- It defaults FALSE, and for a professional project it is refused outright
-- (N6). "Merge and deploy it" in natural language does not ship production.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS nl_grant_may_deploy_production boolean NOT NULL DEFAULT false;

-- What the grant was consumed for, so a second use is visible rather than
-- inferred from timestamps.
ALTER TABLE task_grants ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
ALTER TABLE task_grants ADD COLUMN IF NOT EXISTS consumed_action text;

CREATE INDEX IF NOT EXISTS task_grants_live
  ON task_grants (task_id) WHERE invalidated_at IS NULL;

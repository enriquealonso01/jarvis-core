-- Stage B, the deterministic router (ADR 005, S12b item 1).
--
-- Two of the ADR's seven rules had nowhere to read from. A rule with no table is
-- a rule that silently never fires, and "the router considers your active
-- project" was true of the prose and of nothing else.

-- Rule 5: the sticky "active project" the Control Center sets. One row per
-- operator is all this ever needs; the age of the row is what makes it expire.
CREATE TABLE IF NOT EXISTS active_project (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  set_by text NOT NULL DEFAULT 'console',
  set_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS active_project_recent ON active_project (set_at DESC);

-- Rule 6: a sender bound to one project. DEFAULT OFF, as the ADR says — the row
-- has to exist AND be enabled, so the feature cannot arrive by accident.
CREATE TABLE IF NOT EXISTS sender_project_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL,
  sender text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, sender)
);

-- Which rule routed an event, kept for the same reason task transitions are:
-- "why did this land in Alpha" has to be answerable months later.
ALTER TABLE inbox_events ADD COLUMN IF NOT EXISTS route_rule text;

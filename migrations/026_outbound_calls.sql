-- S23: Jarvis calls Enrique.
--
-- A record of every call it decided to make, INCLUDING the ones it decided not
-- to. The plan's Debug note is the reason: "the commonest failure will be
-- calling too often. Instrument the decision and review a week of it before
-- trusting it; a Jarvis that cries wolf gets silenced permanently." A table of
-- placed calls answers "did it ring"; this answers "how often did it want to".
CREATE TABLE IF NOT EXISTS outbound_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One of the six reasons, and no others.
  reason text NOT NULL,
  -- One sentence: who is calling and why, said before anything else.
  subject text NOT NULL,
  -- What it is about, so a decline can be followed up in writing.
  issue_id uuid REFERENCES issues (id),
  task_id uuid REFERENCES tasks (id),
  project_id uuid REFERENCES projects (id),
  schedule_id uuid REFERENCES schedules (id),

  state text NOT NULL DEFAULT 'wanted'
    CHECK (state IN ('wanted','placed','answered','declined','no_answer','blocked','failed','cancelled')),
  -- Why it did NOT ring, when it did not.
  blocked_reason text,
  -- Quiet hours push a call to 08:00 rather than dropping it.
  retry_after timestamptz,
  call_control_id text,

  wanted_at timestamptz NOT NULL DEFAULT now(),
  placed_at timestamptz,
  ended_at timestamptz,
  -- Deliberately not a retry counter: "never redial in a loop". One attempt,
  -- then WhatsApp. This exists so that rule can be asserted.
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS outbound_calls_due ON outbound_calls (state, retry_after);
CREATE INDEX IF NOT EXISTS outbound_calls_recent ON outbound_calls (wanted_at DESC);

-- A scheduled call is a first-class request: "call me tomorrow at 9 to go over
-- the Alpha migration" creates a schedule whose action is a call, with its
-- subject prepared in advance.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT 'task';
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS call_subject text;

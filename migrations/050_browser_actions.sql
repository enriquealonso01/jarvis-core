-- S32: every browser action leaves evidence.
--
-- "A browser agent that changed something and cannot show what it clicked is
-- indistinguishable from one that changed something else."
--
-- The row is written for READS as well as for changes, and that is deliberate.
-- Recording only the gated actions produces a log in which every entry is
-- alarming and the ordinary browsing that led up to one is missing - so the
-- question "how did it get to that page" has no answer, which is the question
-- somebody actually asks afterwards.
CREATE TABLE IF NOT EXISTS browser_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects (id),
  task_id uuid REFERENCES tasks (id),

  at timestamptz NOT NULL DEFAULT now(),
  url text NOT NULL,
  -- navigate | read | screenshot | click | type | submit | select
  kind text NOT NULL,
  -- What was interacted with, as the page described it: the tag, and the label
  -- a person would have read. Both, because a label alone cannot be found again
  -- and a selector alone cannot be understood.
  element text,
  label text,
  method text,
  destination text,

  -- allow | approval_required | refused
  decision text NOT NULL,
  -- Why, in words. A gate whose refusals are not explainable is a gate nobody
  -- can tell from a bug.
  reason text NOT NULL,
  -- Which rule decided, so a wrong decision is traceable to the rule rather
  -- than to "the classifier".
  rule text NOT NULL,

  approval_id uuid,
  -- S17 artifacts: the page as it was, and as it became.
  before_artifact_id uuid REFERENCES artifacts (id),
  after_artifact_id uuid REFERENCES artifacts (id)
);

CREATE INDEX IF NOT EXISTS browser_actions_project ON browser_actions (project_id, at DESC);
-- The console asks "what did it change", which is not the same list as
-- "what did it do".
CREATE INDEX IF NOT EXISTS browser_actions_changes ON browser_actions (at DESC)
  WHERE decision <> 'allow';

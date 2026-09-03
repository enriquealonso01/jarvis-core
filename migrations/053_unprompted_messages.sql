-- S33: the messages Jarvis starts.
--
-- Everything §17 describes is a REPLY - he asked, Jarvis answers. This table is
-- for the other kind, the message sent when he did not ask for anything, and it
-- exists because those were accumulating with nothing governing them: weekly
-- findings, a proposed capability, an auth handoff, an approval, a maintenance
-- issue, a queued desktop action. "Each one is defensible on its own, and
-- together they turn the pager into a feed."
--
-- Rows are written even when the message is held or refused. A table of SENT
-- messages answers "did it buzz"; only a table of WANTED ones answers "how
-- often did it want to", which is the question that catches a feed forming.
-- This mirrors S23's decision, deliberately: the phone already works this way.
CREATE TABLE IF NOT EXISTS unprompted_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reason text NOT NULL,
  subject text NOT NULL,
  -- "One message per blocker with a working link." Nullable because not every
  -- reason has a page, and a link to nowhere is worse than none.
  link text,
  project_id uuid REFERENCES projects (id),

  wanted_at timestamptz NOT NULL DEFAULT now(),
  -- When it may go. Equal to wanted_at outside quiet hours; the next 08:00
  -- inside them. The plan: held until 08:00, "with the Issue raised
  -- immediately so nothing is lost and the console is accurate at 06:00 if he
  -- looks".
  send_after timestamptz NOT NULL,
  sent_at timestamptz,
  -- Set when several items go out as one message. "Three findings at 09:00 are
  -- one message with three lines, not three notifications."
  batch_id uuid,
  -- refused rows keep why, so a reason that keeps being turned away is visible
  -- rather than silently dropped by a caller that ignored the return value.
  refused_reason text
);

CREATE INDEX IF NOT EXISTS unprompted_pending ON unprompted_messages (send_after)
  WHERE sent_at IS NULL AND refused_reason IS NULL;

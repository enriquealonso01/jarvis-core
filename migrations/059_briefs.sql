-- S40: the plan that was said out loud, which is also the plan being executed.
--
-- "Before substantial or multi-step work, Jarvis says what it is about to do...
-- He can approve it, change it, or ignore it. The brief is a chance to redirect
-- before the work happens."
--
-- The redirection is why this is a table and not a log line. "Changing the plan
-- in reply ('send it to the console instead') changes the execution." If the
-- brief were RECORDED BESIDE the plan, a redirection would update the record of
-- the conversation while the work carried on to WhatsApp - and from his side
-- that is indistinguishable from success right up until the message arrives on
-- the wrong surface. So `plan` here is the object execution reads, and a
-- redirect rewrites it.
--
-- Note what is deliberately absent: the step decomposition. The plan stored is
-- the user-facing one, so nothing downstream of this table can accidentally
-- report internal steps back to him - the Debug note's failure ("if briefs read
-- like task lists, the prompt is exposing the step decomposition") cannot arrive
-- through the database.
CREATE TABLE IF NOT EXISTS briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Where it was said. Nullable because a brief can precede a conversation
  -- being resolved, and losing the brief would be worse than losing the link.
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,

  -- The outcome he asked for, in one clause.
  intent text NOT NULL,

  -- The user-facing plan: intent, handoffs, completion channel. THIS is what
  -- execution reads; see above.
  plan jsonb NOT NULL,

  -- Exactly what was said, kept verbatim. Re-rendering the brief later from the
  -- plan would show him a sentence he was never sent - and after a redirect it
  -- would show the new plan as though it had always been the brief.
  brief_text text NOT NULL,

  sent_at timestamptz NOT NULL DEFAULT now(),

  -- Null means he ignored it, which is a legitimate answer: ignoring a brief
  -- means the work happens. Distinguishing that from a redirect that happened to
  -- agree with the plan is the only way to reconstruct why something went where
  -- it went.
  redirected_at timestamptz
);

-- Briefs are read back per conversation ("what did I say I would do?"), newest
-- first.
CREATE INDEX IF NOT EXISTS briefs_by_conversation
  ON briefs (conversation_id, sent_at DESC);

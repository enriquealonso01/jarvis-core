-- S42: a good engineer says something once.
--
-- "Everything above is about AUTHORITY - whether Jarvis is allowed... Nothing
-- covers disagreeing on the merits of something he is plainly entitled to do.
-- 'Skip the tests and push it.' 'Drop the retention to a day.' On a personal
-- project none of those touch a gate, so they proceed in silence - and a system
-- that only ever objects on rules will quietly do the harmful-but-authorised
-- thing every time."
--
-- This table exists for two reasons and the second is the one that shapes it.
--
-- FIRST, so it can be said ONCE. "Repeating an objection is how an assistant
-- becomes something he routes around, and the second time is always more
-- annoying than the first was useful." A row here is how the second time knows
-- there was a first.
--
-- SECOND, and this is why `was_right` exists while nothing writes it yet:
-- "Objections are recorded, which makes S48 able to ask the only question that
-- matters about them: were they right? A JARVIS THAT OBJECTS AND IS USUALLY
-- WRONG SHOULD OBJECT LESS, and that is measurable rather than a matter of
-- tone." A table that recorded only the objections would make the count
-- available and the judgement impossible.
CREATE TABLE IF NOT EXISTS objections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What is objected to, and on what ground. Together these are the identity:
  -- saying the same thing about the same practice twice is the failure.
  fingerprint text NOT NULL UNIQUE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  action text NOT NULL,
  -- data_loss | irreversible | his_own_rule. A closed set; see src/objection.ts.
  ground text NOT NULL
    CHECK (ground IN ('data_loss', 'irreversible', 'his_own_rule')),

  -- Exactly what was said, in one sentence.
  sentence text NOT NULL,
  said_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid,

  -- NULL means nobody has judged it yet, which is the honest state for almost
  -- all of them. Not `false`: an unjudged objection is not a wrong one, and
  -- defaulting would make S48's question answer itself in the flattering
  -- direction.
  was_right boolean
);

-- The lookup that decides whether to speak is "have I said this before", so that
-- is what the unique index on fingerprint is for - the constraint, not a
-- SELECT-then-INSERT, because two requests arriving together would both find
-- nothing and both object.
CREATE INDEX IF NOT EXISTS objections_judgement
  ON objections (was_right) WHERE was_right IS NOT NULL;

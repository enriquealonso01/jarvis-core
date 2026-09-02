-- S19: the per-call state machine, persisted.
--
-- The turn gate lived in a module-level Map. That is worse than it sounds: an
-- API restart mid-call erased which calls were mid-answer, so the next
-- transcription for a live call was treated as the first — the runaway loop the
-- plan lists as one of the two bugs that must never come back, reachable again
-- by a deploy rather than by a code change.
--
-- `ringing -> greeting -> listening -> thinking -> speaking -> closing`, in a
-- table, so a restart resumes rather than forgets.
CREATE TABLE IF NOT EXISTS calls (
  call_control_id text PRIMARY KEY,
  call_leg_id text,
  from_e164 text,
  conversation_id uuid REFERENCES conversations(id),
  state text NOT NULL DEFAULT 'ringing'
    CHECK (state IN ('ringing','greeting','listening','thinking','speaking','closing','ended')),
  -- When the CURRENT leg must be finished by. A leg with no deadline is a leg
  -- that can hang forever, which is what "a hung call is almost always an
  -- awaited promise with no timeout" means in practice.
  deadline_at timestamptz,
  -- What the deadline is for, so a blown one can say something true.
  deadline_leg text,
  turns integer NOT NULL DEFAULT 0,
  -- How many times the caller has been asked whether they are still there.
  -- The second unanswered prompt closes the call rather than holding an open
  -- line at a per-minute rate until the carrier gives up.
  silence_prompts integer NOT NULL DEFAULT 0,
  transcript_artifact_id uuid REFERENCES artifacts(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  state_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text
);
CREATE INDEX IF NOT EXISTS calls_live ON calls (state) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS calls_deadline ON calls (deadline_at) WHERE ended_at IS NULL;

-- Every transition, for the same reason tasks have one: "if turns interleave
-- wrongly, that is where to look" is only true if the order was written down.
CREATE TABLE IF NOT EXISTS call_transitions (
  id bigserial PRIMARY KEY,
  call_control_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  from_state text,
  to_state text NOT NULL,
  cause text,
  -- The Telnyx event that caused it, so a capture can be replayed against it.
  event_type text
);
CREATE INDEX IF NOT EXISTS call_transitions_call ON call_transitions (call_control_id, at);

-- S21: the conversational orchestration runtime.
--
-- A turn is no longer "a transcription in, a sentence out". It is an
-- acknowledgement, a tool track that runs while the line stays open, progress
-- lines on a schedule, and either an answer or a clean handover to the queue.
-- All of it has to be inspectable afterwards, for two reasons: "it felt slow"
-- has to become a number, and "it said the same thing three times" has to be
-- mechanically checkable rather than a matter of opinion.
CREATE TABLE IF NOT EXISTS call_turns (
  id bigserial PRIMARY KEY,
  call_control_id text NOT NULL,
  n integer NOT NULL,
  heard text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  -- Every leg, separately. The plan is explicit that when a call feels sluggish
  -- the timings are read BEFORE the prompts are touched — it is almost always
  -- TTS render on an uncached phrase, not the model.
  ack_ms integer,
  model_ms integer,
  tts_ms integer,
  total_ms integer,
  tool_started_at timestamptz,
  tool_ended_at timestamptz,
  answer_text text,
  answered_at timestamptz,
  handover_task_id uuid REFERENCES tasks (id),
  inbox_event_id uuid REFERENCES inbox_events (id),
  outcome text NOT NULL DEFAULT 'open'
    CHECK (outcome IN ('open','answered','handed_over','interrupted','failed'))
);
CREATE INDEX IF NOT EXISTS call_turns_call ON call_turns (call_control_id, n);

-- Every line Jarvis spoke, in order, with what kind of line it was.
--
-- This is what makes "never the same acknowledgement twice in a row" a query
-- rather than a hope, and it is where the variety test greps for consecutive
-- duplicates. It also survives a restart, which the plan calls out by name:
-- "if acknowledgements repeat, the no-repeat state is being lost between turns
-- — check it lives on the call, not in a request-scoped variable."
CREATE TABLE IF NOT EXISTS call_speech (
  id bigserial PRIMARY KEY,
  call_control_id text NOT NULL,
  turn_id bigint REFERENCES call_turns (id),
  kind text NOT NULL CHECK (kind IN ('ack','checking','progress','handover','answer','closing','holding')),
  text text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_speech_call ON call_speech (call_control_id, at);

-- The acknowledgement that was actually said, on the turn it belongs to. The
-- variety test reads `call_speech`; this is for reading one turn at a glance.
ALTER TABLE call_turns ADD COLUMN IF NOT EXISTS ack_text text;

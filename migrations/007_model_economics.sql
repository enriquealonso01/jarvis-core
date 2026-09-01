-- Model economics: what each route costs, and what it has actually spent.
--
-- `model_registry` carried `cost_type` but no prices, and every provider's
-- `usage` block was discarded on arrival. So Jarvis could route between models
-- without knowing that one was thirty times dearer than another, and nothing
-- anywhere could answer "what did this month cost". Both are prerequisites for
-- letting Jarvis choose its own models.

ALTER TABLE model_registry
  ADD COLUMN IF NOT EXISTS input_cost_per_mtok  numeric(10, 4),
  ADD COLUMN IF NOT EXISTS output_cost_per_mtok numeric(10, 4),
  -- Whether the weights can be taken in-house. This is policy-bearing, not
  -- trivia: an open-weights-only instance must be able to refuse a route.
  ADD COLUMN IF NOT EXISTS open_weights boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS license text;

COMMENT ON COLUMN model_registry.input_cost_per_mtok IS
  'USD per million input tokens. NULL means unpriced — treat as unknown, never as free.';
COMMENT ON COLUMN model_registry.open_weights IS
  'Weights are published under a license permitting self-hosting.';

-- One row per provider call. Written from the response `usage` block, so the
-- cost is measured rather than estimated.
CREATE TABLE IF NOT EXISTS model_usage (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at                timestamptz NOT NULL DEFAULT now(),
  provider          text NOT NULL,
  model_id          text NOT NULL,
  role              text,
  conversation_id   uuid,
  task_id           uuid,
  input_tokens      integer NOT NULL DEFAULT 0,
  output_tokens     integer NOT NULL DEFAULT 0,
  cached_tokens     integer NOT NULL DEFAULT 0,
  -- Priced at write time from the registry. Kept on the row so a later price
  -- change cannot silently rewrite history.
  cost_usd          numeric(12, 6),
  transport         text NOT NULL DEFAULT 'http'
);

CREATE INDEX IF NOT EXISTS model_usage_at_idx ON model_usage (at DESC);
CREATE INDEX IF NOT EXISTS model_usage_model_idx ON model_usage (provider, model_id, at DESC);

-- Standing policy for how Jarvis is allowed to choose models. One row.
CREATE TABLE IF NOT EXISTS model_policy (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  open_weights_only      boolean NOT NULL DEFAULT false,
  monthly_ceiling_usd    numeric(10, 2),
  -- Jarvis may reorder and enable routes on its own within these bounds.
  -- Anything that adds a *new* paid provider stays an approval.
  autonomy               text NOT NULL DEFAULT 'propose'
                           CHECK (autonomy IN ('off', 'propose', 'reorder', 'full')),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

INSERT INTO model_policy (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Prices as published September 2026. Anything not listed stays NULL, which the
-- API reports as "unpriced" rather than guessing.
UPDATE model_registry SET open_weights = true, license = 'Apache-2.0',
       input_cost_per_mtok = 0.15, output_cost_per_mtok = 0.60
 WHERE model_id = 'openai/gpt-oss-120b';

UPDATE model_registry SET open_weights = true, license = 'Apache-2.0',
       input_cost_per_mtok = 0.10, output_cost_per_mtok = 0.30
 WHERE model_id LIKE 'qwen/%';

UPDATE model_registry SET open_weights = true, license = 'NVIDIA Open Model'
 WHERE provider = 'nvidia';

UPDATE model_registry SET open_weights = false, license = 'proprietary'
 WHERE provider IN ('google', 'anthropic', 'openai_codex', 'cursor', 'elevenlabs');

UPDATE model_registry SET input_cost_per_mtok = 0.30, output_cost_per_mtok = 2.50
 WHERE provider = 'google' AND model_id LIKE '%flash%';

-- S25: quota is a routable resource, and the model list is cut to what is real.
--
-- The plan is explicit: "The plan has been treating a subscription limit as an
-- error — park the task and notify. That is wrong, and it wastes the main
-- advantage of running on flat-rate subscriptions. Remaining quota is an input
-- to routing."
--
-- Nothing here invents a number. Where a provider reports quota, the report is
-- stored; where it does not, what was OBSERVED is stored (a 429, and the reset
-- header if there was one) and the derived figure is marked as an estimate. A
-- confident wrong quota figure is worse than an honest unknown, because it
-- routes around an engine that was actually available.

-- ---------------------------------------------------------------------------
-- 1. Quota, per auth profile.
-- ---------------------------------------------------------------------------

-- `auth_profiles.quota_json` has existed since 001 and nothing has ever written
-- it — the "exists as a row in a table" category from 0.5. It gets a shape and
-- a writer here rather than a second column beside it.
COMMENT ON COLUMN auth_profiles.quota_json IS
  'S25 quota state: {status: healthy|limited|exhausted|unknown, remaining_pct, '
  'estimated: bool, resets_at: timestamptz, source: reported|inferred, detail, '
  'observed_at}. estimated=true means no provider API reported this — it was '
  'inferred from an observed rate-limit response.';

-- The evidence behind an inferred number. Without this, "cursor is exhausted"
-- is an assertion; with it, it is a reading with a timestamp and a cause.
CREATE TABLE IF NOT EXISTS quota_observations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at               timestamptz NOT NULL DEFAULT now(),
  auth_profile_id  text NOT NULL REFERENCES auth_profiles (id) ON DELETE CASCADE,
  -- What happened, not what was concluded from it.
  kind             text NOT NULL
                     CHECK (kind IN ('reported', 'rate_limited', 'exhausted', 'served', 'reset')),
  status           text,
  remaining_pct    numeric(5, 2),
  estimated        boolean NOT NULL DEFAULT true,
  resets_at        timestamptz,
  detail           text,
  task_id          uuid
);

CREATE INDEX IF NOT EXISTS quota_observations_profile_idx
  ON quota_observations (auth_profile_id, at DESC);

-- ---------------------------------------------------------------------------
-- 2. Two ceilings, not one.
-- ---------------------------------------------------------------------------
-- The plan asks for both points: the soft ceiling notifies once and changes
-- nothing; the hard ceiling drops metered routes and leaves subscription work
-- running. One number cannot do both.
ALTER TABLE model_policy
  ADD COLUMN IF NOT EXISTS soft_ceiling_usd numeric(10, 2),
  -- The month in which the soft ceiling has already been announced. "Exactly one
  -- notification" is a property of this column: a boolean would need clearing by
  -- hand every month, and a timestamp would need a rule about how old is old.
  ADD COLUMN IF NOT EXISTS soft_notified_month date;

COMMENT ON COLUMN model_policy.soft_ceiling_usd IS
  'Month-to-date spend above this notifies once and changes nothing. NULL means '
  '80 percent of the hard ceiling.';

-- ---------------------------------------------------------------------------
-- 3. The engineering fallback, by name.
-- ---------------------------------------------------------------------------
-- "The last rung of that ladder must be a specific model on the hosted provider,
-- probed and registered like any other route — otherwise the day every
-- subscription is exhausted is the day someone discovers the fallback was a
-- phrase."
--
-- Chosen against the four criteria the plan sets, from what Fireworks actually
-- serves (its catalogue was listed with the stored key, not guessed):
--
--   open weights .... moonshotai/Kimi-K2.7-Code, published on HuggingFace, so
--                     the provider stays replaceable (VI.0).
--   coding, long .... the provider description: "coding-focused agentic model
--   horizon, tools    ... substantial improvements on real-world long-horizon
--                     coding tasks ... end-to-end task completion across complex
--                     software engineering workflows", and supports_tools=true,
--                     which the probe re-checks with a real tool call.
--   context ......... 262,144 tokens. A repository slice, not a file.
--   cheap enough .... 0.95 in / 4.00 out per Mtok. A long agentic run of ~400k
--                     cumulative input and ~60k output is about 0.62 USD, so a
--                     25 USD ceiling holds dozens of them. Kimi K3 was the other
--                     candidate at 3.00/15.00 — one frontier run could take a
--                     tenth of the month, which is a fallback that runs once.
--
-- Registered `discovered`: it becomes routable when the probe has made a real
-- tool-enabled call against it, and not before.
INSERT INTO model_registry
  (provider, model_id, role_assignments, health, approval_state, route_order,
   auth_profile_id, endpoint_url, open_weights, license,
   input_cost_per_mtok, output_cost_per_mtok, context_size)
VALUES
  ('fireworks', 'accounts/fireworks/models/kimi-k2p7-code',
   ARRAY['senior_engineer'], 'unknown', 'discovered', 40,
   'fireworks', 'https://api.fireworks.ai/inference/v1/chat/completions',
   true, 'Modified MIT', 0.95, 4.00, 262144)
ON CONFLICT (provider, model_id) DO UPDATE SET
  role_assignments = EXCLUDED.role_assignments,
  route_order      = EXCLUDED.route_order,
  endpoint_url     = EXCLUDED.endpoint_url,
  open_weights     = EXCLUDED.open_weights,
  input_cost_per_mtok  = EXCLUDED.input_cost_per_mtok,
  output_cost_per_mtok = EXCLUDED.output_cost_per_mtok,
  context_size     = EXCLUDED.context_size;

-- ---------------------------------------------------------------------------
-- 4. A reviewer from a different family than the implementer (VI.3).
-- ---------------------------------------------------------------------------
-- The starting routes put implementer and reviewer both on Claude, and the
-- fallback the plan itself offered for that was "a second Claude context" — the
-- letter of independent review without its purpose. GLM-5.3 is a different
-- family from both the Claude implementer and the Kimi fallback above, so
-- whichever engine writes the diff, the reviewer is not from its family.
-- Reviewing a diff costs a fraction of producing one, so the higher per-token
-- price barely registers. S29 benchmarks the role properly; this is the starting
-- order, not the verdict.
INSERT INTO model_registry
  (provider, model_id, role_assignments, health, approval_state, route_order,
   auth_profile_id, endpoint_url, open_weights, license,
   input_cost_per_mtok, output_cost_per_mtok, context_size)
VALUES
  ('fireworks', 'accounts/fireworks/models/glm-5p3',
   ARRAY['reviewer'], 'unknown', 'discovered', 4,
   'fireworks', 'https://api.fireworks.ai/inference/v1/chat/completions',
   true, 'MIT', 1.40, 4.40, 1048576)
ON CONFLICT (provider, model_id) DO UPDATE SET
  role_assignments = EXCLUDED.role_assignments,
  route_order      = EXCLUDED.route_order,
  endpoint_url     = EXCLUDED.endpoint_url,
  open_weights     = EXCLUDED.open_weights,
  input_cost_per_mtok  = EXCLUDED.input_cost_per_mtok,
  output_cost_per_mtok = EXCLUDED.output_cost_per_mtok,
  context_size     = EXCLUDED.context_size;

-- ---------------------------------------------------------------------------
-- 5. Cut the dead free-tier chain.
-- ---------------------------------------------------------------------------
-- "Cut to what is real." Every row removed here is BOTH degraded-or-unserving
-- AND not the only route for any role it holds. Measured from `model_usage`
-- over the life of the table, and from `model_registry.health`:
--
--   google/gemini-3.1-pro-preview ..... degraded, 0 calls, reviewer+engineer
--   nvidia/moonshotai/kimi-k3 ......... degraded, 0 calls, engineer
--   nvidia/deepseek-v4-pro-0813 ....... degraded, 0 calls, engineer+reviewer
--                                       (upstream deprecation date 2026-08-27)
--   nvidia/nemotron-3.5-lightning ..... degraded, 1 call, utility
--   google/gemini-3.1-flash-lite ...... healthy, 0 calls, utility
--
-- Kept deliberately: google/gemini-3.6-flash is the ONLY vision route and
-- nvidia/nemotron-3-embed-1b the ONLY embeddings route. Deleting the last route
-- for a role does not simplify the chain, it empties it.
DELETE FROM model_registry
 WHERE (provider, model_id) IN (
   ('google', 'gemini-3.1-pro-preview'),
   ('nvidia', 'moonshotai/kimi-k3'),
   ('nvidia', 'deepseek-ai/deepseek-v4-pro-0813'),
   ('nvidia', 'nvidia/nemotron-3.5-lightning-30b-a3b'),
   ('google', 'gemini-3.1-flash-lite')
 );

-- Supervisor keeps a primary and ONE fallback, which is what the plan asks for
-- and what the traffic supports: fireworks deepseek-v4-flash-0731 served 52 of
-- the 62 recorded calls; groq gpt-oss-120b is the fallback. The other two lose
-- the supervisor role and keep the roles they actually serve.
UPDATE model_registry
   SET role_assignments = array_remove(role_assignments, 'supervisor')
 WHERE (provider, model_id) IN (
   ('nvidia', 'nvidia/nemotron-3-super-120b-a12b'),
   ('groq',   'qwen/qwen3.8-27b')
 );

-- A row whose roles are now empty is not a route, it is litter.
DELETE FROM model_registry WHERE cardinality(role_assignments) = 0;

-- ---------------------------------------------------------------------------
-- 6. Prices that were wrong, and open weights that were not marked.
-- ---------------------------------------------------------------------------
-- 007 priced `deepseek-v4-flash` before the row existed as `-0731`, and the
-- published price has moved since: 0.22/0.66, not 0.14/0.28. Existing
-- `model_usage` rows are NOT rewritten — cost is priced at write time precisely
-- so that a later price change cannot silently rewrite history.
UPDATE model_registry
   SET input_cost_per_mtok = 0.22, output_cost_per_mtok = 0.66, context_size = 1048576
 WHERE provider = 'fireworks' AND model_id = 'accounts/fireworks/models/deepseek-v4-flash-0731';

-- gpt-oss is Apache-2.0 and qwen3 is Apache-2.0; both were sitting at the
-- open_weights default of false, which makes an open-weights-only policy read
-- as though almost nothing qualifies.
UPDATE model_registry SET open_weights = true, license = 'Apache-2.0'
 WHERE provider = 'groq' AND (model_id LIKE 'openai/gpt-oss%' OR model_id LIKE 'qwen/%');

-- ---------------------------------------------------------------------------
-- 7. Which harness runs a route, declared rather than assumed.
-- ---------------------------------------------------------------------------
-- `runner.ts` spawns `claude` and writes `tasks.harness = 'claude_code'` for
-- every run, while `resolveProfile` happily accepts any `subscription_login`
-- profile the task names. So a task pinned to `cursor_personal` would have
-- launched the Claude CLI pointed at a Cursor config directory: a route that
-- looks registered, is selectable, and cannot work.
--
-- Naming the harness on the route makes the ladder able to tell the difference
-- between "this engine is busy" and "nothing here can run this engine yet".
-- The second is S28, the runtime interface. Until it lands, those rungs are
-- skipped WITH THEIR REASON rather than silently or fatally — the same
-- treatment the recovery ladder gives its own unimplemented rungs.
ALTER TABLE model_registry
  ADD COLUMN IF NOT EXISTS harness text;

COMMENT ON COLUMN model_registry.harness IS
  'For senior_engineer/reviewer routes: which executor runs it. claude_code is '
  'implemented; codex and cursor_acp await S28. NULL means an HTTP chat route '
  'that needs no executor.';

UPDATE model_registry SET harness = 'claude_code'
 WHERE provider = 'anthropic' AND model_id = 'claude-sonnet-host';
UPDATE model_registry SET harness = 'codex'
 WHERE provider = 'openai_codex' AND model_id = 'codex-host';
UPDATE model_registry SET harness = 'cursor_acp'
 WHERE provider = 'cursor' AND model_id = 'cursor-acp-host';
-- The hosted fallback is a chat model behind an agent loop, not a CLI. It gets
-- its executor from S28 as well; naming it here would claim an executor exists.
UPDATE model_registry SET harness = 'http_agent'
 WHERE provider = 'fireworks' AND model_id = 'accounts/fireworks/models/kimi-k2p7-code';

-- ---------------------------------------------------------------------------
-- 8. Write down the access that already exists, rather than changing it.
-- ---------------------------------------------------------------------------
-- The engineer ladder asks the broker whether a profile may run a project, and
-- the broker fails closed (S12). `auth_profile_allowlists` is empty, so without
-- this every heavy task everywhere would park with "not allowlisted" the moment
-- S25 deploys. That is not a security improvement, it is an outage.
--
-- What is true today is that the three subscription logins are usable by every
-- project, because nothing consulted the allowlist for them at all. These rows
-- record exactly that and change nothing. What DOES change is the direction:
-- from here, access is explicit, a project created later gets no row until
-- someone grants one, and narrowing an existing grant is a row deletion rather
-- than a code change.
--
-- The roles are scoped to `senior_engineer`, because that is the only thing
-- these profiles are used for.
INSERT INTO auth_profile_allowlists (auth_profile_id, project_id, allowed_roles)
SELECT a.id, p.id, ARRAY['senior_engineer']
  FROM auth_profiles a
 CROSS JOIN projects p
 WHERE a.auth_type = 'subscription_login'
ON CONFLICT DO NOTHING;

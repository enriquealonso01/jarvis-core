-- Fireworks as the paid, open-weights Supervisor primary; Gemini out of the chain.
--
-- Evidence for the reorder, measured over 24h from `supervisor.route`:
--   nemotron-3-super  served 135 turns, always as the 3rd fallback
--   qwen3.8-27b       served   9
--   gpt-oss-120b      served   9, as the nominal primary
--   gemini-3.6-flash  served   0
--
-- The chain was upside down, and the one closed model in it contributed nothing.

-- auth_profiles has `owner`, not `scope`; scope lives on `connections`.
-- Shaped to match the existing groq/nvidia rows rather than guessed:
-- auth_profiles has `owner`/`billing_owner`, not `scope`, and owner is the operator.
INSERT INTO auth_profiles (id, provider, display_name, owner, billing_owner, auth_type, health)
VALUES ('fireworks', 'fireworks', 'Fireworks AI', 'Enrique', 'Enrique', 'api_key', 'unknown')
ON CONFLICT (id) DO NOTHING;

-- Gives the Connections page something to render an "Add key" form against, so
-- the key is submitted to the broker and encrypted rather than pasted anywhere else.
INSERT INTO connections (slug, kind, scope, auth_profile_id, health)
VALUES ('fireworks', 'fireworks', 'system', 'fireworks', 'unknown')
ON CONFLICT (slug) DO NOTHING;

-- DeepSeek V4 Flash: MIT weights, 1M context, $0.14/$0.28 per Mtok.
-- Left `discovered` until the catalog probe proves the key works against it —
-- an unprobed route must never be routable just because a row exists.
INSERT INTO model_registry
  (provider, model_id, role_assignments, health, approval_state, route_order,
   auth_profile_id, endpoint_url, open_weights, license,
   input_cost_per_mtok, output_cost_per_mtok, context_size)
VALUES
  ('fireworks', 'accounts/fireworks/models/deepseek-v4-flash',
   ARRAY['supervisor', 'utility'], 'unknown', 'discovered', 0,
   'fireworks', 'https://api.fireworks.ai/inference/v1/chat/completions',
   true, 'MIT', 0.14, 0.28, 1000000)
ON CONFLICT DO NOTHING;

-- Gemini keeps its vision role — there is no open vision route configured yet,
-- and removing it would leave that role empty rather than open.
UPDATE model_registry
   SET role_assignments = array_remove(role_assignments, 'supervisor')
 WHERE provider = 'google' AND 'supervisor' = ANY (role_assignments);

-- Re-rank what remains so the order matches what actually serves traffic.
UPDATE model_registry SET route_order = 10 WHERE model_id = 'nvidia/nemotron-3-super-120b-a12b';
UPDATE model_registry SET route_order = 20 WHERE model_id = 'openai/gpt-oss-120b';
UPDATE model_registry SET route_order = 30 WHERE model_id = 'qwen/qwen3.8-27b';

-- The instance is open-weights-only from here; the ceiling is Enrique's number.
UPDATE model_policy
   SET open_weights_only = true,
       monthly_ceiling_usd = 25.00,
       updated_at = now();

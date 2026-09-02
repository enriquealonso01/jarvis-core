-- Which credentials a confidential project may use.
--
-- Enrique's decision: a confidential project may use all PAID models - the
-- subscription logins and fireworks - and no free tier. The reasoning is about
-- what the provider does with the text: a free tier is paid for with data.
--
-- Free tiers stay {normal} on purpose, named here so the omission reads as a
-- decision rather than an oversight: groq, nvidia, google_ai.
--
-- `restricted` is deliberately NOT widened for anything. It was not part of the
-- decision, and the rule is that a profile defaults to {normal} and widens on
-- purpose - so the stricter class stays closed until it is asked for explicitly.
--
-- Service connections (telnyx, elevenlabs, composio) are NOT touched here. They
-- carry a confidential project's content just as a model does, but they are not
-- models and the decision was about models. Raised as its own question.
UPDATE auth_profiles
   SET confidentiality_eligibility = ARRAY['normal', 'confidential']::text[]
 WHERE id IN ('anthropic_personal', 'cursor_personal', 'openai_codex_personal', 'fireworks');

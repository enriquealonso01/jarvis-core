-- Which SERVICES a confidential project may use.
--
-- 034 widened the models and said this was deliberately left open: "Service
-- connections (telnyx, elevenlabs, composio) are NOT touched here. They carry a
-- confidential project's content just as a model does, but they are not models
-- and the decision was about models. Raised as its own question."
--
-- B9 is the answer to that question. Enrique's decision (2026-09-03): a
-- confidential project MAY use all three. All have credentials; telnyx and
-- elevenlabs are healthy.
--
-- `restricted` is again NOT widened, for the same reason 034 gives and because
-- B9 says so outright: the tier stays empty until a professional project exists,
-- and the restriction choices are Enrique's to make by hand rather than
-- something this migration should anticipate. A profile defaults to {normal} and
-- widens on purpose.
UPDATE auth_profiles
   SET confidentiality_eligibility = ARRAY['normal', 'confidential']::text[]
 WHERE id IN ('telnyx', 'elevenlabs', 'composio');

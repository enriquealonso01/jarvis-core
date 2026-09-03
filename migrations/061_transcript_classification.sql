-- S41: a transcript is a copy, and it outlives the call.
--
-- "S24 stores every call's transcript. A call where a confidential document was
-- discussed produces a transcript CONTAINING THAT DISCUSSION, stored under
-- ordinary retention, indexed by S30, and reachable by any future recall -
-- including by voice. That is a leak inside Jarvis rather than to a vendor, and
-- it is the sort that compounds: the content moves from a classified artifact
-- into an unclassified transcript, and every downstream feature treats it as
-- ordinary."
--
-- The rule is "a transcript inherits the strictest classification of anything
-- discussed in it", and that cannot be read off the transcript's own project,
-- because a call can range across several. So two columns, and they are
-- deliberately not the same thing:
--
--   calls.discussed_projects  - the EVIDENCE. What was actually brought up.
--   artifacts.confidentiality - the STAMP. What downstream reads.
--
-- Derived from the evidence and then written down, rather than derived on every
-- read: a future recall asking "may I say this out loud" must get its answer
-- from the artifact in front of it, not by reconstructing a call that happened
-- in March from rows that may since have been pruned. The suite asserts the
-- stamp equals the strictest of the evidence, so the two cannot drift silently.
ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS discussed_projects uuid[] NOT NULL DEFAULT ARRAY[]::uuid[];

-- NULL means "not stamped, so inherit from the project" - which is the correct
-- reading for every artifact that existed before this column did, and is not the
-- same as 'normal'. Defaulting to 'normal' would have quietly declassified every
-- transcript already on disk.
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS confidentiality text
    CHECK (confidentiality IN ('normal', 'confidential', 'restricted'));

-- Recall reads by classification constantly ("what may I read aloud"), so the
-- column that gates speech is the one that needs the index.
CREATE INDEX IF NOT EXISTS artifacts_confidentiality
  ON artifacts (confidentiality) WHERE confidentiality IS NOT NULL;

-- S30: what a chunk has to carry to be retrievable and citable.
--
-- The table held body, project and source artifact. That is enough to store
-- text and not enough to answer with it:
--
--   * `search` is the tsvector the ranking reads. Generated, so it cannot drift
--     from the body the way a trigger-maintained column does when somebody
--     writes a row the trigger did not expect.
--   * `locator` and `char_offset` are what make a citation say "page 4" or
--     "function total" rather than "somewhere in this document" - and what let
--     a wrong answer be traced back to the chunk that caused it.
--   * `kind`, `source_date` and `chunk_index` are stored now although nothing
--     reads them yet. S41 wants a time index so a document is findable by "two
--     days ago" and not only by content; a chunk written today without a usable
--     date gives it nothing to search on later, and backfilling a date nobody
--     recorded is guesswork.
ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS kind        text,
  ADD COLUMN IF NOT EXISTS locator     text,
  ADD COLUMN IF NOT EXISTS char_offset integer,
  ADD COLUMN IF NOT EXISTS chunk_index integer,
  ADD COLUMN IF NOT EXISTS source_date timestamptz;

ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED;

CREATE INDEX IF NOT EXISTS knowledge_chunks_search_idx ON knowledge_chunks USING GIN (search);

-- Retrieval is always scoped: a project's chunks, or the global tier. Without
-- this the scope filter is a sequential scan over everything ever dumped.
CREATE INDEX IF NOT EXISTS knowledge_chunks_project_idx ON knowledge_chunks (project_id);

-- S41 will ask for "two days ago", which is a range scan on this.
CREATE INDEX IF NOT EXISTS knowledge_chunks_date_idx ON knowledge_chunks (source_date DESC NULLS LAST);

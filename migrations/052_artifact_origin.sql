-- S32: a scraped artifact carries where it came from.
--
-- "Scraped output is an artifact, so S30 indexes it, so a question three weeks
-- later can retrieve it - and by then nothing about it says a stranger wrote
-- it."
--
-- That last clause is the whole reason for this column. Three weeks after a
-- scrape, a chunk of somebody's product page and a chunk of a document Enrique
-- wrote are the same shape in the same table, ranked by the same query, and the
-- citation is the only thing that could tell them apart. The plan is explicit:
-- "'According to a page on example.com' and 'according to your notes' must
-- never render the same way."
--
-- On `artifacts` rather than on `knowledge_chunks` because the origin is a fact
-- about the DOCUMENT, not about each slice of it - storing it per chunk is
-- twelve copies of one fact and eleven chances for them to disagree.
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS origin_url text;

COMMENT ON COLUMN artifacts.origin_url IS
  'S32: the web address this came from. Set for scraped content; NULL for anything Enrique produced or uploaded.';

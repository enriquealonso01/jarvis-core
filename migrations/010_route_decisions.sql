-- S3a: the classifier's verdict, recorded on the inbox event.
--
-- Wrong routing is this step's failure mode and it is invisible unless the
-- decision is written down. `routing_note` already existed and carried a free
-- text reason; what was missing is the verdict itself and the segmentation, so
-- that "a three-way split that produced two destinations" can be told apart
-- from "a three-way split routed wrongly" by reading one row.

ALTER TABLE inbox_events
  ADD COLUMN route_category text
    CHECK (route_category IN ('capture', 'question', 'work', 'instruction', 'ambiguous', 'mixed')),
  ADD COLUMN route_segments jsonb,
  ADD COLUMN route_decided_at timestamptz,
  ADD COLUMN route_model text;

-- Reading a day of decisions is the documented debugging move, so make it cheap.
CREATE INDEX inbox_events_route_category_received
  ON inbox_events (route_category, received_at DESC);

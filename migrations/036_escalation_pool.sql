-- A normal pool and an escalation pool, per the plan's Part on routing.
--
-- Fallback answers "this route is down". Escalation answers "this work turned
-- out to be harder than the route it was given" - a different trigger, and the
-- ladder had no way to express it. Rung 8 read "switch model within the
-- approved pool" and satisfied it with a LATERAL move: any other approved route
-- for the role, ordered by route_order, which re-runs the same failure at the
-- same price.
--
-- Everything starts in the normal pool. That is deliberate rather than lazy:
-- which models are worth escalating TO is a question S29's benchmark answers by
-- measurement, and inventing an ordering here would be exactly the opinion the
-- step exists to replace. Until then every role has an empty escalation pool,
-- which is a valid configuration - stt and embeddings have nowhere to go
-- anyway - and the ladder is required to fail cleanly on it rather than
-- escalating to nothing.
ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS pool text NOT NULL DEFAULT 'normal'
  CHECK (pool IN ('normal', 'escalation'));

COMMENT ON COLUMN model_registry.pool IS
  'normal: ordinary work starts here, cheapest first. escalation: only reachable when a task has already failed on its normal route (recovery rung 8).';

-- Escalation is one-way within a task, and it has to be visible without reading
-- a log: "a task shape that escalates every time is a pool assignment that is
-- wrong". The shape is the role, which is what a pool is assigned by.
CREATE TABLE IF NOT EXISTS escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks (id),
  shape text NOT NULL,
  from_profile text,
  to_profile text NOT NULL,
  cause text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS escalations_shape_idx ON escalations (shape, at DESC);

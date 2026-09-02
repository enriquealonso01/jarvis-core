-- S18b: dedupe internal posts on their request id (IV.7).
--
-- The fifth of the five duplicate-delivery sources, and the one with no owner:
-- the internal HMAC endpoints (`/internal/inbox/ingest`, `/internal/workers/*`,
-- `/internal/schedules/fire`) had no idempotency at all. A retried post — and
-- everything that posts to them retries — created a second row.
--
-- Keyed on the caller's request id, not on a hash of the body: two genuinely
-- different events can carry identical bodies (the same schedule firing twice),
-- and collapsing those would lose one.
CREATE TABLE IF NOT EXISTS internal_requests (
  request_id text PRIMARY KEY,
  route text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  -- What the first call answered, so a retry gets the same answer rather than
  -- a bare "already done" the caller cannot use.
  response jsonb
);
CREATE INDEX IF NOT EXISTS internal_requests_at ON internal_requests (at DESC);

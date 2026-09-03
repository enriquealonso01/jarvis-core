-- A connection that hangs gets taken out of service (plan S31 Debug).
--
-- "An MCP server that hangs takes the heavy lane with it: every MCP invocation
-- needs a timeout, and a server that times out twice gets disabled with an
-- Issue rather than retried forever."
--
-- Disabled is kept apart from `health` on purpose. Health is an observation -
-- the last test said yes or no - and it is overwritten by the next test.
-- Disabled is a DECISION, and one that has to survive the next optimistic
-- health check: a server that hung twice should not come back into service
-- because a cheap probe answered quickly a minute later.
--
-- The counter is consecutive, not cumulative. A connection that times out once
-- a month is annoying; one that times out twice in a row is broken, and the
-- difference is what stops a slow, working service from being disabled on its
-- second bad day of the year.

ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_reason text,
  ADD COLUMN IF NOT EXISTS consecutive_timeouts int NOT NULL DEFAULT 0;

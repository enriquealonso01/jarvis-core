-- S31: a server that hangs must not take the heavy lane with it.
--
-- The plan's Debug section: "An MCP server that hangs takes the heavy lane with
-- it: every MCP invocation needs a timeout, and a server that times out twice
-- gets disabled with an Issue rather than retried forever."
--
-- The counter is CONSECUTIVE, and reset by a success. A cumulative count
-- disables a server that has worked a thousand times and timed out twice over a
-- year, which is a healthy server with a slow afternoon; two in a row without a
-- success between them is a server that is not answering.
ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS consecutive_timeouts integer NOT NULL DEFAULT 0,
  -- Set when Jarvis disables it itself. A disabled connection is refused by the
  -- broker's first check, so nothing reaches it - including the paths that ask
  -- the weaker "may this project reach it at all" question.
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_reason text,
  -- Per connection, because a local file read and a remote MCP server have
  -- nothing in common about how long "too long" is. Null takes the default.
  ADD COLUMN IF NOT EXISTS timeout_ms integer;

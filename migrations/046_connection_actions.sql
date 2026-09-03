-- S31: a connection is a set of actions, not a switch.
--
-- The plan is blunt about why. Composio concentrates it - one connection is a
-- gateway to hundreds of services - so "project A may use Composio" and
-- "project A may send email as Enrique" are different statements, and a boolean
-- collapses them into the wider one. The same is true of an MCP server, of an
-- API key that can read and delete, and of a local directory.
--
-- Empty means NOTHING is permitted, not everything. An allowlist whose empty
-- state means "all" is not an allowlist, and Part IV.4 says these fail closed -
-- this table has already been bitten by exactly that, twice, in the project and
-- profile allowlists that only enforced membership when rows happened to exist.
ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS permitted_actions text[] NOT NULL DEFAULT ARRAY[]::text[];

-- What the connector needs to do its work, and nothing secret: a native
-- connection's root directory, an api connection's base URL. Secrets stay in
-- `credentials`, reached through the broker, never here.
COMMENT ON COLUMN connections.permitted_actions IS
  'S31: the actions this connection may perform. Empty permits nothing.';

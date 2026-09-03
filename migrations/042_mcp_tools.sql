-- What an MCP server says it offers, kept apart from what it is permitted to do.
--
-- Two tables rather than one, because a catalogue and a permission are
-- different statements and collapsing them is what makes "attached and inert"
-- impossible to express. `mcp_tools` is what the server CLAIMS - names,
-- descriptions and schemas, all authored by the server's author, none of it
-- trusted. `connection_actions` is what a person decided, and a tool appears
-- there only after somebody classified it.
--
-- So a freshly attached server has rows here and none there: every tool visible,
-- nothing callable. That is the plan's rule - "the server is attached and inert"
-- - and it falls out of the shape rather than needing a flag to enforce it.
--
-- `manifest_hash` is over the name, description and schema TOGETHER, not over a
-- version string. The version is authored by the same party as the tool, and
-- many servers return descriptions dynamically at list time without ever
-- changing it, so pinning to a self-reported version is trusting the changelog
-- of whoever you are gating.

CREATE TABLE IF NOT EXISTS mcp_tools (
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Untrusted text. Rendered to a person as a quotation, never assembled into
  -- instructions for a model.
  description text,
  input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- sha256 of name + description + schema. Changing any of them re-opens
  -- classification, whatever the server calls its version.
  manifest_hash text NOT NULL,
  -- What the server called itself when this was listed. Recorded because it is
  -- useful evidence, and NOT used to decide whether to re-classify.
  server_version text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, name)
);

CREATE INDEX IF NOT EXISTS mcp_tools_conn_idx ON mcp_tools (connection_id);

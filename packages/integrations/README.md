# packages/integrations

Jarvis Integrations **package** (plan §5.3, ADR 010). Not a separate GitHub repo in V1.

Will contain:

- Connection manifests (kind, scopes, permission schema)
- MCP server adapters
- Composio adapter (`composio.invoke`)
- HTTP adapters
- Integration tests

Do not put provider master secrets here. Broker loads ciphertext at runtime.

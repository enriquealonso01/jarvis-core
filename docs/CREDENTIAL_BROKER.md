# Credential broker

Workers and UI never receive master credentials. They call typed capabilities. Implementation: `internal/broker` in Core.

## Check order (plan §9)

1. Identify project_id + task_id (system jobs use the matching system project).
2. Load project classification and policy.
3. Resolve connection **and** auth_profile (fail if only a provider name was supplied).
4. Check scope, project allowlist, role allowlist, confidentiality, spend policy.
5. Check task grant or approval if the capability requires it.
6. Unwrap the narrowest token (or perform the HTTP call inside the broker).
7. Redact; audit `broker.invoke` with capability, project, task, connection id, not secrets.

Deny: 403, Issue `security.broker_deny` if the caller looks like cross-project probing (audit always).

---

## Capability catalog (V1)

### GitHub — personal admin (system, broker-only)

| id | extra confirm |
|---|---|
| `github.admin.create_private_repository` | no |
| `github.admin.register_deploy_key` | no |
| `github.admin.create_repo_scoped_pat` | no (or GitHub App add-repo) |
| `github.admin.delete_repository` | **always** |
| `github.admin.set_visibility_public` | **always** |
| `github.admin.transfer` | **always** |
| `github.admin.archive` | **always** if repo active |
| `github.admin.weaken_branch_protection` | **always** |

Admin must not be selectable as a project connection.

### GitHub — project repo

| id | extra confirm | credential |
|---|---|---|
| `github.repo.clone_url` | no | deploy key metadata only |
| `github.repo.create_branch` | no | API |
| `github.repo.open_pull_request` | no | API |
| `github.repo.update_pull_request` | no | API |
| `github.repo.list_checks` | no | API |
| `github.repo.merge_pull_request` | task grant or approval | API |
| `github.repo.mint_short_lived_git_token` | no | API, TTL ≤ 1h, one repo |

### Netlify

`netlify.create_site`, `netlify.create_deploy`, `netlify.promote_deploy` (grant/approval for production), `netlify.get_site`, `connection.test`.

### Providers

`connection.test` for groq, nvidia, google, anthropic (each **profile**), openai/codex, cursor, elevenlabs, telnyx, backup (restic snapshots list).

No `provider.complete_chat` that bypasses model router.

### Generic

`connection.test`  
`composio.invoke` (tool name + args; allowlisted tools per connection)  
`mcp.call` (server id + tool; server must have declared permissions)

### Forbidden

`shell.as_root`, `read_file(/var/lib/jarvis/keys)`, `docker.socket`, `openclaw.admin_token.read`.

---

## Short-lived GitHub tokens in a harness

Only if the task cannot use broker PR APIs (e.g. harness `gh pr create`). Mint via `github.repo.mint_short_lived_git_token`, inject env for that process, revoke/expire after task leaves `running`. Never write it into the repo or logs.

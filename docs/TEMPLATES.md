# Templates

## Project AGENTS.md (managed repos)

Jarvis writes this at onboarding and reads it at every engineering task.

This block is the template, and it is **compared byte for byte against
`AGENTS_TEMPLATE` in `src/agentsfile.ts`** by `scripts/s26-onboarding-test.ts`.
The constant is what ships — the production image copies `src`, `migrations` and
`packages`, not `docs` — and this is where a human reads it. Edit either one and
the test fails until they match again.

Every placeholder is named after the onboarding field that fills it, so
"which answer is missing" has an answer. The allowed values are listed under the
block rather than inside it, because a placeholder that reads
`{{personal|professional}}` cannot be substituted by field name.

```markdown
# Agent instructions — {{project_name}}

## Classification
- project_type: {{project_type}}
- production_status: {{production_status}}
- customer_facing: {{customer_facing}}
- confidentiality: {{confidentiality}}

## Repository
- owner/repo: {{github_owner}}/{{github_repo}}
- default_branch: {{default_branch}}
- credential: repository-specific only (never personal admin)

## Approved auth profiles
- {{allowed_auth_profiles}}
- Approved external data processors: {{approved_data_processors}}

## Commands
- Setup: {{setup_command}}
- Test: {{test_command}}
- Lint/type: {{lint_command}}

## Environments
- Safe: {{safe_environments}}
- Production deploy: {{deploy_policy}}

## Forbidden
- Cross-project files/secrets
- Weakening isolation/auth/backups
- {{project_forbidden}}

## PR / deploy gates
- Before PR: {{before_pr}}
- Before deploy: {{before_deploy}}
- Migrations: {{migration_policy}}

## Queue
- Default priority: {{default_queue_priority}}
```

Allowed values:

- `project_type`: `personal` | `professional` | `system`
- `production_status`: `non_production` | `staging` | `production`
- `customer_facing`: `yes` | `no`
- `confidentiality`: `normal` | `confidential` | `restricted`

Every other placeholder is free text, and **"none" is a valid answer while blank
is not**. A project with no lint command has answered the lint question; a
project that has not been asked has not. Onboarding refuses to finalize on the
second and accepts the first.

## Professional onboarding questions (must ask)

1. Personal or professional?
2. Production / customer-facing?
3. Confidentiality?
4. Exact GitHub owner/repo (or create new private under personal)?
5. Which auth profiles may see this data?
6. Metered paid APIs? Default **no**. Ceiling if yes.
7. Deploy environments and approval rules.
8. Required tests, review, backups, monitoring.

Professional/confidential projects: follow plan §28.2 generics during onboarding. Do not bake a named customer into the template.

## UserActionRequest WhatsApp copy

Keep one short message:

`Jarvis needs {{one_line}}. {{project}} — {{link}} (expires 2h)`

## Issue titles

Pattern: `[{{service}}] {{class}} — {{short}}`

## Improvement recommendation artifact

Markdown: candidate, source, license, permissions, sandbox result, privacy, cost, risk, **asks approval** for anything that changes trust/billing/isolation.

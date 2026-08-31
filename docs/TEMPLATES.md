# Templates

## Project AGENTS.md (managed repos)

Jarvis writes this at onboarding and reads it at every engineering task.

```markdown
# Agent instructions — {{project_name}}

## Classification
- project_type: {{personal|professional|system}}
- production_status: {{non_production|staging|production}}
- customer_facing: {{yes|no}}
- confidentiality: {{normal|confidential|restricted}}

## Repository
- owner/repo: {{github_owner}}/{{github_repo}}
- default_branch: {{default_branch}}
- credential: repository-specific only (never personal admin)

## Approved auth profiles
- {{list}}
- Approved external data processors: {{list}}

## Commands
- Setup: {{ }}
- Test: {{ }}
- Lint/type: {{ }}

## Environments
- Safe: {{ }}
- Production deploy: {{policy}}

## Forbidden
- Cross-project files/secrets
- Weakening isolation/auth/backups
- {{project-specific}}

## PR / deploy gates
- Before PR: {{ }}
- Before deploy: {{ }}
- Migrations: {{ }}

## Queue
- Default priority: {{ }}
```

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

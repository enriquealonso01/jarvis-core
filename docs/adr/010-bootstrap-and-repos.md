# ADR 010 — Bootstrap and repository layout

- Status: accepted
- Date: 2026-08-31
- Plan sections: §5, §63, §5.3
- Affects isolation / billing / always-confirm: no

## Decision

**Phase 0 is partly manual.** The broker cannot create `jarvis-core` until Core exists.

Enrique (or an agent on his laptop) by hand:

1. Create private GitHub repos `jarvis-core` and `jarvis-control-center`.
2. Push this documentation tree as the start of `jarvis-core`.
3. Provision Netcup, Tailscale, DNS for `jarvis.<domain>`, B2 bucket, Telnyx/ElevenLabs/WhatsApp later as phases require.
4. Create GitHub App or PATs for `github_personal_admin` and store them **after** the API can encrypt (or bootstrap secrets file used once).

Subsequent personal repos are broker-created (§10).

**V1 repo count: two.**

- `jarvis-core` — API, policy, bridge plugin, Compose, integrations **package**
- `jarvis-control-center` — Next.js UI

`jarvis-integrations` is **not** a third repo in V1. It is `packages/integrations` inside Core (plan §5.3 allowed this). Split later only via ADR.

Improvement and Maintenance are the only seeded Postgres system projects (ADR 012). Their code lives in Core (`internal/improvement`, `internal/maintenance`). They are not separate GitHub repos unless the operator later asks Jarvis to create them.

Control Center is implemented as the `jarvis-control-center` git repo. It is **not** a seeded Jarvis work project; the operator may register it later through chat. Production UI is Caddy-served (ADR 004); Netlify remains preview hosting.

## Why

The plan allowed collapsing Integrations. Two repos is the minimum that still matches “frontend is its own system project.”

## Alternatives rejected

- **Monorepo for UI+API** — contradicts §2.2 / §5.2 as a first-class repo. Keep two.
- **Automate creating jarvis-core with the broker** — circular.

## Consequences

- Phase 0 checklist does not include “broker creates jarvis-core.”
- No customer GitHub org is configured at bootstrap.
- **Rollback:** none needed — the manual Phase 0 steps are one-time. If the broker later gains repo-creation for its own repos, this ADR is superseded rather than reversed; the two existing repos are not recreated.

## User approval required

No.

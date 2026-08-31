# Plan coverage map

Every master-plan heading has a home. If you need behavior and it is not in this table, write an ADR — do not invent a feature.

Frozen text: `JARVIS_V1_MASTER_PLAN_v1.2.md` (v1.1 historical).

| Plan | Implementation |
|---|---|
| §0–0.1 purpose / v1.2 decisions | Plan itself; quiet hours, audio, GitHub, dedicated WA; ADR 012 seed scope |
| §1 identity | CONTRACT Part I; models as adapters |
| §2.1 Netcup | SERVER_LAYOUT; ADR 007 |
| §2.2 Netlify UI | ADR 004; CONTROL_CENTER; ADR 010 |
| §2.3 backend list | SERVER_LAYOUT Compose |
| §2.4 no Supabase | CONTRACT |
| §3 OpenClaw OS | ADR 001–002; OPENCLAW_INTEGRATION |
| §4 harnesses | ADR 006; ADR 011; models.seed.yaml |
| §5.1 Core | this repo; ADR 010–011 |
| §5.2 Control Center | CONTROL_CENTER; separate repo |
| §5.3 Integrations | `packages/integrations`; Composio kind in CONTRACT |
| §5.4 Improvement | CONTRACT §5.4; **seeded at boot**; TEMPLATES recommendation |
| §5.5 Maintenance | CONTRACT §5.5; **seeded at boot**; ERROR_TAXONOMY; SERVER_LAYOUT |
| §6.1 OpenClaw owns | ADR 001 |
| §6.2 Postgres owns | DATA_MODEL |
| §6.3 queue | WORKERS; DATA_MODEL tasks |
| §6.4 files | DATA_MODEL artifacts; SERVER_LAYOUT |
| §7 isolation | ADR 002, 006; FULL_LOOPS L6 L9 |
| §7.1 classification | DATA_MODEL projects; TEMPLATES onboarding |
| §8–8.5 connections / profiles | DATA_MODEL; CREDENTIAL_BROKER |
| §9 broker | CREDENTIAL_BROKER |
| §10 GitHub | ADR 003 |
| §11 Netlify | CREDENTIAL_BROKER; ADR 004 |
| §12 human connection | ADR 004; CONTROL_CENTER action pages |
| §13.1–13.4 authz | CONTRACT Part V; DATA_MODEL grants/approvals; STATE_MACHINES |
| §14 Inbox | DATA_MODEL inbox_events; OPENCLAW_INTEGRATION |
| §15 conv/task | ADR 005; DATA_MODEL; global Supervisor conversation; SUPERVISOR.md; FIRST_SLICE |
| §16 WhatsApp | OPENCLAW_INTEGRATION; SERVER_LAYOUT QR |
| §17 notify | DATA_MODEL outbox; CONTRACT brevity |
| §18 phone | ADR 009; CONTRACT phone cannot §13.3 |
| §18.1 quiet hours | ERROR_TAXONOMY telnyx.quiet_hours; FULL_LOOPS L13 |
| §18.2 audio | DATA_MODEL artifacts retention; L12 |
| §19 ElevenLabs | models.seed; site.yaml voice_id at bootstrap |
| §20 lanes | ADR 007; WORKERS |
| §21 queue rules | ADR 007; WORKERS |
| §22 routing feedback | ADR 005; API reroute |
| §23 task states | STATE_MACHINES |
| §24 watchdog | ERROR_TAXONOMY; CONTRACT §24 |
| §25 checkpoints | WORKERS payload |
| §26 schedules | ADR 001; DATA_MODEL schedules |
| §27 engineer workflow | CONTRACT; task phases |
| §28 AGENTS.md / onboard | TEMPLATES; ADR 005; §28.2 generic professional policy |
| §29 review | CONTRACT |
| §30 eval suite | DATA_MODEL benchmarks; Phase 6 |
| §31–34 models | DATA_MODEL registry; CONTRACT |
| §35 candidates | config/models.seed.yaml |
| §36–37 free tier / cost | CONTRACT; auth_profiles flags |
| §38–43 UI | CONTROL_CENTER |
| §44 UI security | ADR 004; L16 |
| §45 taxonomy | ERROR_TAXONOMY |
| §46–47 observability | CONTRACT; API health; audit_events |
| §48 self-heal | CONTRACT §5.5 |
| §49–53 security | SERVER_LAYOUT; ADR 008–009 |
| §54–56 backup | SERVER_LAYOUT; ADR 008 |
| §57 updates | CONTRACT; Compose + Netlify previews |
| §58–60 improvement governance | CONTRACT; config_versions |
| §61–62 cost / growth | ADR 007; Maintenance disk |
| §63–70 phases | PHASE_CHECKLIST |
| §71–86 acceptance | FULL_LOOPS L1–L19 |
| §87–91 preferences | Plan; not re-opened without ADR |
| §XIX platform URLs | re-fetch at implement; ADR if behavior changed |
| §XX freeze / ADRs | `docs/adr/TEMPLATE.md` |

## Operator-supplied at bootstrap (not architecture)

Fill `config/site.yaml` (gitignored): domain, GitHub username, Netcup SKU, B2 repo, ElevenLabs `voice_id`, Telnyx numbers, dedicated WhatsApp E.164, allowlist numbers.

Professional GitHub orgs and project-owned model subscriptions are **not** bootstrap items. They are collected when the operator creates that project in chat.

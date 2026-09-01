# ADR 012 — V1 is a general OS; no named customer projects

- Status: accepted
- Date: 2026-08-31
- Plan sections: §5, §7.1, §8.5, §28, §35, §63–67, §76, §80.1, §87, §89
- Affects isolation / billing / always-confirm: no (removes a named tenant; keeps generic isolation)
- User approval: yes (this conversation)

## Decision

Jarvis V1 is a **general personal operating system**. It must not be fingerprinted for any specific customer or employer project (including TicketFlipping).

**Seeded Jarvis projects at first boot (only these two):**

- `jarvis-improvement`
- `jarvis-maintenance`

Plus their default schedules/tasks (weekly Improvement, Maintenance health/retention). No other application projects are created in Phase 0–3.

**Not seeded as Jarvis projects:** personal apps, professional/customer work, TicketFlipping, and even `jarvis-core` / `jarvis-control-center` as work projects. Those two names remain the **git repositories we implement**. The operator later creates managed projects through Control Center chat (or WhatsApp), including “this repo is Jarvis Core,” by answering onboarding questions.

**First operator loop:** open the Control Center, talk to the Supervisor in an **unscoped (global) conversation**, paste documentation and setup, and ask Jarvis to create projects from that. The infrastructure (registry, isolation, broker, grants, onboarding) must already work; the project list starts almost empty.

**Professional vs personal** is collected **at project creation**, not baked into the binary. Generic rules remain:

- Professional projects default to higher queue priority, no personal GitHub, no consumer/free endpoints unless approved, metered spend off, production deploy not NL-granted unless the project flag is set.
- A **project-owned** subscription/auth profile (when the user adds one) is never used by the Supervisor, Improvement, Maintenance, or another project.
- Confidential/restricted bodies use `metadata_only` Supervisor payloads (ADR 005, generic — not named for one company).

TicketFlipping may be created later as an ordinary professional project via chat. It must not appear in seed data, profile ids, unix users, example copy, or acceptance fixtures.

## Why

The frozen v1.1 plan used TicketFlipping as the exemplar professional tenant. That would make the OS look and test like a TicketFlipping tool. The product is an always-on agent; projects are grown day by day.

## Alternatives rejected

- **Keep TF as a hidden seed, just don’t show it** — still a fingerprint in schema and tests.
- **Seed Core and Control Center as work projects too** — operator will register those through chat when ready. The code still ships as two repos (ADR 010).

## Consequences

- Canonical plan is **v1.2**.
- Seed auth profiles: personal/system only (`anthropic_personal`, `openai_codex_personal`, `cursor_personal`, `github_personal_admin`, plus Groq/NVIDIA/Google/ElevenLabs/Telnyx/backup as connections). No `anthropic_ticketflipping`.
- Unix users: `jarvis` plus **per-project** uids created at project-create time when isolation requires it — not `jarvis-tf`.
- Acceptance isolation tests create two **temporary** projects during the test, not a preloaded customer project.
- Example WhatsApp copy uses a generic project name.
- **Rollback:** seeding a customer or employer project later is just project creation through onboarding, so nothing has to be undone. Reversing the decision the other way — removing a project that has been fingerprinted into the seed data — means a data migration, which is exactly what this ADR avoids.

## User approval required

Yes — given in chat 2026-08-31.

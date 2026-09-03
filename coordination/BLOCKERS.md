# Blockers — things only Enrique can do

Written only by the Blockers session (Enrique + Claude). Agents READ this and
re-check with the `CHECK:` probe; they never edit it and never trust the status
line alone.

Status: `OPEN` (Enrique still needs to act) or `CLEARED` (Enrique acted — but an
agent believes it only when `CHECK` passes).

---

## B1 — Autonomy consent  ·  Status: CLEARED 2026-09-03
The Builder and Tester create and merge their own PRs and the Tester deploys to
the box, all autonomously. Enrique confirmed 2026-09-03: **full autonomy** — yes
to unattended merges to `main`, the Tester deploying to the live box, and
migrations applied to the live DB. No guardrail requested.
- **CHECK:** this line reads `CLEARED`. Agents may build, test, open PRs, and deploy to the box as designed.

## B2 — WhatsApp channel is down  ·  Status: CLEARED 2026-09-03
Paired 2026-09-03 (QR scanned), then the inbound bug was fixed — the bridge now
claims inbound with `before_dispatch` (PR #267) and the extensions-dir deploy gap
was closed. VERIFIED end-to-end on the box 2026-09-03 16:29Z: a real inbound
WhatsApp ("Hi! How are you?" from +13055052646) landed as an `inbox_events` row
with `channel='whatsapp'`, with the gateway `Up (healthy)`. Both halves of CHECK
pass. (History: earlier the message was delivered to the phone but never persisted
— 0 rows — because the bridge listened on hooks that never fire for inbound and
the gateway ran a stale copy of the bridge.)
- **CHECK:** on the box, `docker ps --format '{{.Names}} {{.Status}}' | grep openclaw` shows it `Up`, AND a test WhatsApp message to the number appears as a new `inbox_events` row with `channel='whatsapp'`.

## B3 — Onboarding engine-grant policy (decision)  ·  Status: CLEARED 2026-09-03
Raised by the Monitor so the last BROKEN front-door item could close honestly: a
brand-new API-onboarded project has NO engine allowlisted, so its first task sits
in `waiting_for_provider` forever. The question was whether that is a bug or the
plan working.
Ruling (Enrique, 2026-09-03): **onboarding does NOT auto-grant engines.** Granting
an engineering auth-profile (`anthropic_personal` / `openai_codex_personal` /
`cursor_personal`, role `senior_engineer`) to a new project stays a **deliberate
onboarding step** — fail-closed per S12b and the "no automatic paid API
enablement" non-negotiable. No plan change; the Tester must NOT implement
auto-grant.
Consequence: the front door is **working as designed**. The "onboard with zero
manual steps" bar is retired. The engine grant is a legitimate onboarding step,
not "manual patching."
- **CHECK:** none for Enrique — this is a recorded ruling. The front door is
  VERIFIED (by the Tester, in `VERIFIED.md`) when a fresh API-onboarded project,
  after the deliberate engine grant, takes a plain-English `/api/inbox` bug to a
  real PR on the box.

## B4 — (add as they arise)
The Blockers session appends new items here as agents report things only you can do.

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

## B4 — e2e fixture cleanup: capture evidence, then delete both repos  ·  Status: CLEARED 2026-09-03
Authorization from Enrique (2026-09-03), recorded here so the Tester can
corroborate an irreversible action against this file rather than a bare relay.
Enrique's decision: **capture PR #1's diff + metadata into the durable record
FIRST** (so the `VERIFIED.md` citation to that PR does not 404), **then delete
BOTH throwaway repos** — `jarvis-e2e-gbbqkr` and `jarvis-e2e-3e4adc11` — **and
their project rows.** Order is load-bearing: evidence capture precedes deletion.
The Tester (jarvis-1f) raised and owns these fixtures and is authorized to perform
the deletion; the Blockers session does not delete. If the Tester's own permission
layer gates the repo delete or the row DELETE, Enrique approves that in the
Tester's session.
- **CHECK:** proceed once this line reads `CLEARED`. Done when PR #1's diff +
  metadata live in a durable non-throwaway location (VERIFIED.md or an artifact it
  references) AND both repos + both project rows are gone.

## B5 — budget-spending live tests authorized  ·  Status: CLEARED 2026-09-03
Authorization from Enrique (2026-09-03) with full cost disclosure. He green-lit
running all four live tests knowing the spend:
- **S23** and **s22-live-call-to-pr** — place REAL Telnyx calls (per-minute
  charges to his account; his actual phone rings).
- **s37-ingest-live** — spends Groq minutes.
- **s28-parity-live** — creates a real GitHub repo and runs two harnesses (model
  usage on the anthropic subscription plus codex/cursor).
None is destructive; the cost is money and a ringing phone. Run all four, record
each result in `VERIFIED.md`. A defect surfaced by a live test is a finding, not a
failure of the go-ahead.
- **CHECK:** proceed once this line reads `CLEARED`.

## B6 — (add as they arise)
The Blockers session appends new items here as agents report things only you can do.

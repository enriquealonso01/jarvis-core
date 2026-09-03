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

## B2 — WhatsApp channel is down  ·  Status: OPEN
Enrique's part is DONE: QR scanned and the channel paired 2026-09-03 (gateway is
`Up (healthy)`, re-paired with no QR). Still OPEN for a **code** reason, not
Enrique: inbound WhatsApp is delivered to the phone but never persisted to
`inbox_events` (verified live 2026-09-03 — 0 rows after a real message). Root-caused
by the Tester (see `VERIFIED.md`): the bridge listens on hooks that never fire for
inbound (needs `before_dispatch`), and the gateway runs a stale copy of the bridge
from its extensions dir that the normal deploy never updates. **No further Enrique
action** until the Tester deploys the fix — then Enrique sends ONE real inbound
message to verify.
- **CHECK:** on the box, `docker ps --format '{{.Names}} {{.Status}}' | grep openclaw` shows it `Up`, AND a test WhatsApp message to the number appears as a new `inbox_events` row with `channel='whatsapp'`.

## B3 — (add as they arise)
The Blockers session appends new items here as agents report things only you can do.

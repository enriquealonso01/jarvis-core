# Blockers — things only Enrique can do

Written only by the Blockers session (Enrique + Claude). Agents READ this and
re-check with the `CHECK:` probe; they never edit it and never trust the status
line alone.

Status: `OPEN` (Enrique still needs to act) or `CLEARED` (Enrique acted — but an
agent believes it only when `CHECK` passes).

---

## B1 — Autonomy consent  ·  Status: OPEN
The Builder and Tester create and merge their own PRs and the Tester deploys to
the box, all autonomously. Confirm this is what you want.
- **CHECK:** this line reads `CLEARED`. Until then, agents may build, test, open PRs, and deploy to the box as designed (this consent is about you being comfortable, not a technical gate).

## B2 — WhatsApp channel is down  ·  Status: OPEN
The `openclaw` gateway exited and WhatsApp is not receiving. Re-pairing needs you
to scan the QR (the Tester can bring the gateway up and surface a fresh QR; you scan it).
- **CHECK:** on the box, `docker ps --format '{{.Names}} {{.Status}}' | grep openclaw` shows it `Up`, AND a test WhatsApp message to the number appears as a new `inbox_events` row.

## B3 — (add as they arise)
The Blockers session appends new items here as agents report things only you can do.

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
- **S23** — places a REAL Telnyx call (per-minute charge; his actual phone rings).
  **Correction (Tester, 2026-09-03):** `s22-live-call-to-pr` does NOT ring his
  phone — it synthesises the Telnyx webhooks and only the carrier is simulated, so
  this entry originally overstated that one. The genuinely phone-ringing script is
  `s23-place-one.ts` (one call, needs an existing outbound_calls row).
- **s37-ingest-live** — spends Groq minutes.
- **s28-parity-live** — creates a real GitHub repo and runs two harnesses (model
  usage on the anthropic subscription plus codex/cursor).
None is destructive; the cost is money and a ringing phone. Run all four, record
each result in `VERIFIED.md`. A defect surfaced by a live test is a finding, not a
failure of the go-ahead.
- **CHECK:** proceed once this line reads `CLEARED`.

## B6 — S35 off-machine restore proof deferred  ·  Status: CLEARED 2026-09-03
Enrique's decision (2026-09-03): the box itself IS the backup. We do NOT need a
second machine now, nor to prove off-machine export/restore right now. S35's
"restore on a second machine with the first switched off" Done-when is DEFERRED by
decision — revisit when there is a reason. The local backup mechanism stays; the
cross-machine proof is out of scope for now. Agents stop treating S35 as
blocked-on-hardware.

## B7 — Composio credential provided (S31)  ·  Status: CLEARED 2026-09-03
Enrique connected Composio via the Control Center; the `composio` connection row
now has a credential (verified 2026-09-03 19:57Z). NOTE its health currently reads
`degraded`, not `healthy` — the credential is present but a real Composio call is
not yet proven. Builder: proceed to S31's Done-when ("a heavy task does real work
through a Composio connection"); a successful heavy-task run IS the proof. If
`degraded` blocks real work, flag it as a finding rather than claiming done.

## B8 — S32 fetch tier-2 TLS client = powhttp  ·  Status: CLEARED 2026-09-03
"Paw HTTPS" = **powhttp** — <https://github.com/usestring/powhttp-mcp> (verified
real; an MCP server that fetches via powhttp). Builder: implement the
declared-but-unimplemented S32 tier-2 rung against this, not pyhttpx/curl_cffi.

## B9 — Confidentiality: services eligible; restricted deferred; no restriction work  ·  Status: CLEARED 2026-09-03
Enrique's decision (2026-09-03): a confidential project MAY use all three services
— **telnyx, elevenlabs, composio** (all have credentials; telnyx/elevenlabs
healthy). The `restricted` tier stays **EMPTY** until a professional project is
started. **Do NOT build or tighten restriction logic now** — restriction choices
are Enrique's to make later, by hand. Models for confidential remain at the
existing position (paid subscription logins eligible, free tiers not) unless
Enrique says otherwise.

## B10 — Notification policy for 3 unhandled failure classes  ·  Status: CLEARED 2026-09-03
Enrique confirmed these (2026-09-03), replacing the silent `worker.crash` /
`ui_only` inheritance:
- `agent.repeat` (fires in prod) → severity **error**, notify **Issue + WhatsApp**
- `dependency.unavailable` → severity **warning**, notify **Issue + ui_only**
- `resource.cpu` → severity **warning**, notify **ui_only** (Issue if sustained)

## B11 — Orphan cleanup authorized: delete all + reap  ·  Status: CLEARED 2026-09-03
Enrique authorized (2026-09-03) deleting ALL of the following, and having the
parity fixture auto-reap going forward:
- the 14 orphan `s28-parity-*` GitHub repos + their 14 project rows
- the orphan schema: tables `connection_actions` and `mcp_tools` + stray
  `schema_migrations` rows 041, 042, 044, 045
- the stale deployed source `adapters.ts` and `connector.ts` on the box (imported
  by nothing)
Execution: the repo deletions need the `delete_repo` scope resolved (see B13); the
schema drop is destructive prod DB work (Tester proposes the migration and executes
under this authorization); removing the source is a prod deletion. Tester executes;
if its permission layer gates a step, Enrique approves in the Tester's session — no
self-granting scopes.
- **CHECK:** proceed once this line reads `CLEARED`.

## B12 — S29 benchmark spend authorized (generous)  ·  Status: CLEARED 2026-09-03
Enrique authorized (2026-09-03) running the S29 benchmark to populate the
escalation pool, with generous budget: "spend as much as you need; the accounts I
provided have limits, so don't optimise for cheapness." The account-level limits
are the guardrail. Run it and record results in `VERIFIED.md`.

## B13 — `delete_repo` scope to execute the authorized repo deletions  ·  Status: CLEARED 2026-09-03
Enrique granted it himself (2026-09-03): `gh auth refresh -s delete_repo` on the
shared workstation credential. Verified authoritatively against GitHub — the token
now reports scopes `delete_repo, gist, read:org, repo, workflow`. The Tester was
right not to self-widen the scope; Enrique did it. The repo deletions authorised in
B4 (2 e2e repos) and B11 (14 s28-parity repos) can now execute. **B4's order still
holds: capture PR #1's evidence into the durable record BEFORE
`jarvis-e2e-3e4adc11` is deleted.**
- **CHECK:** proceed once this line reads `CLEARED`; done when all authorised repos
  are gone. (`gh api user` X-Oauth-Scopes includes `delete_repo`.)

## B14 — (add as they arise)
The Blockers session appends new items here as agents report things only you can do.

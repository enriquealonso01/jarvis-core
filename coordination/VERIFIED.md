# Verified on the box

Written only by the Tester/Operator session. A line here means it was watched
working on the running box — not that a local test passed.

`✓ VERIFIED` = seen working on the box, with the date and what was checked.
`✗ BROKEN`   = found broken; what and where. The Tester fixes these, redeploys, re-verifies, then flips the line to ✓.

Currently verifying: _front-door bugs. #1 and #2 done. Next: WhatsApp inbound persistence (was B2, now a code fix), then #3._

---

## ✓ VERIFIED

- **2026-09-03 — Voice/console → task → real PR.** A plain-English instruction through `/api/inbox` became a heavy task, Claude Code reproduced a multi-file rounding bug, fixed it, added a regression test, and opened `enriquealonso01/jarvis-proof-01#1` (4 tests, 4 pass). **Caveat:** required three manual onboarding patches — see BROKEN. The engine itself is sound; the front door was not.

- **2026-09-03 — Deploy-key endpoint (was BROKEN #1).** Fixed in PR #258 (`id::text = $1`), deployed with `scripts/deploy-core.sh`, runner restarted, then checked against the running API on the box via `scripts/verify-deploy-key.mjs`:
  - `POST /api/projects/definitely-not-a-real-slug-xyz/deploy-key` → **404** `{"error":"project not found"}` — the lookup no longer aborts before it can miss.
  - `POST /api/projects/jarvis-proof-01/deploy-key` → **200**, real key provisioned (`fingerprint SHA256:hk1Z+fNazFajqoPF8HuQmRQJhXaVhPwPP5f/cpirxpk`).
  - Pre-fix cause confirmed against the live database, not a fixture: `SELECT ... WHERE id = 'jarvis-proof-01' OR slug = 'jarvis-proof-01'` → `ERROR: invalid input syntax for type uuid`. One placeholder was bound against a `uuid` column and a `text` column at once.
  - The same line was fixed in the PR-create and PR-merge handlers. Those two are **not** verified yet — only the deploy-key path was exercised.

- **2026-09-03 — New-project dirs are runner-writable (was BROKEN #2).** Fixed in PR #261 (`mkdirForRunner`, inheriting the parent's owner), deployed, then verified with `scripts/verify-project-dirs.mjs` creating a real project through the running API:
  - Before: `POST /api/projects` → 200, and all three dirs `uid=0 gid=0 mode=750`; `sudo -u jarvis touch .../probe` → **Permission denied**. That is what killed every heavy task on an API-onboarded project.
  - After: all three dirs `uid=1000 gid=988 mode=750`, and `sudo -u jarvis touch` **succeeds**.
  - Probe projects use the `proj-accept-` slug prefix, so the acceptance sweep archives them.

## ✗ BROKEN — Tester backlog (start here)

1. **WhatsApp inbound is never persisted — the bridge hooks never fire.** (Was blocker B2; the Blockers session confirmed pairing is done, so this is now purely a code fix. Highest priority: it is the front door.) Diagnosed on the box 2026-09-03:
   - Pairing is fine and inbound really arrives: `[whatsapp] Inbound message +1305… -> +13056453617 (direct, 87 chars)` at 15:33:41 and again 15:36:10.
   - **Neither bridge hook fires.** `packages/openclaw-jarvis-bridge/index.js` logs on every fire, and no `[jarvis-bridge] message_received fired` or `before_agent_run fired` line ever appears. `openclaw plugins inspect jarvis-bridge --runtime --json` says `status: loaded`, `hookCount: 2` — but `hookNames: []`.
   - Instead the message goes straight to OpenClaw's own model and dies there: `[agent/embedded] … reason=auth`, `401 Unauthorized … api.openai.com`. Harmless today (no OpenAI key, so no rogue replies) but it proves the bridge is bypassed, not merely failing.
   - **Wrong hooks.** `/app/docs/plugins/hooks.md` in the image lists `message_received` as **Observe** only, and says `inbound_claim` "is not a global pre-routing broadcast — OpenClaw invokes it only for the plugin that owns the message's conversation binding". The hook that matches what the bridge wants is **`before_dispatch`** (Kind: *Claim*, "Handle an inbound message before the normal model dispatch"). `before_agent_run` is documented as working only "on a supported runner", and the inbound path here uses the embedded runner.
   - **Also a deploy gap, found while diagnosing.** The gateway loads the plugin from `/home/node/.openclaw/extensions/jarvis-bridge/index.js`, **not** from the compose bind mount `/plugins/jarvis-bridge`. The running copy is `md5 59060d73…` while the repo copy is `8f7c3cbd…` — the extensions copy is a stale Sep-2 snapshot. `scripts/deploy-core.sh` updates the repo tree and therefore **never updates the bridge the gateway actually runs**. Any bridge fix must also sync that directory and restart the gateway, or it will silently not take effect.
   - Verifying the fix needs one real inbound WhatsApp; I will ask for one once the fix is deployed.

2. **No per-project GitHub API credential on onboarding.** A new project gets a deploy key (can push a branch) but no per-project github api credential, so it cannot open a PR, and the account-wide admin token is correctly refused. Onboarding must provision a per-project github credential (the bench path does; the API path does not).

3. **openclaw stays down once it stops — but NOT for the reason originally recorded.** Re-diagnosed 2026-09-03; the original entry blamed a missing restart policy and that is wrong:
   - The container already has `restart: unless-stopped`, in `deploy/compose.yaml` **and** on the live container (`docker inspect` → `{"Name":"unless-stopped"}`).
   - It did not crash. Its log ends `[admission] closed: restart drain` / `received SIGTERM` / `completed cleanly in 398ms`, exit **0**, `RestartCount=0`. Docker never tried to restart it because it was *explicitly stopped* — and `unless-stopped` deliberately does not resurrect that.
   - **`deploy-core.sh` was the suspect and has been cleared by experiment.** api and worker were `Up 3 hours` ≈ the same 12:08, so the deploy looked responsible. I started openclaw, ran a full `deploy-core.sh`, and openclaw came through `Up (healthy)`. It is not the deploy. A `received SIGUSR1; restarting` at 12:05:05 shows something was signalling the gateway around then; what issued the 12:08 SIGTERM is still open.
   - So a restart policy is not the fix. What is missing is that a dead input channel is **silent** — that wants a health check that raises an issue, not a flag that is already set.
   - Gateway is currently **Up (healthy)** and WhatsApp re-paired; I restarted it 15:28 and it reconnected with no QR.

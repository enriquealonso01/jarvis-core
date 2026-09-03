# Verified on the box

Written only by the Tester/Operator session. A line here means it was watched
working on the running box — not that a local test passed.

`✓ VERIFIED` = seen working on the box, with the date and what was checked.
`✗ BROKEN`   = found broken; what and where. The Tester fixes these, redeploys, re-verifies, then flips the line to ✓.

Currently verifying: _front-door bugs 1–4. #1 done; #2 and #3 next; #4 re-diagnosed._

---

## ✓ VERIFIED

- **2026-09-03 — Voice/console → task → real PR.** A plain-English instruction through `/api/inbox` became a heavy task, Claude Code reproduced a multi-file rounding bug, fixed it, added a regression test, and opened `enriquealonso01/jarvis-proof-01#1` (4 tests, 4 pass). **Caveat:** required three manual onboarding patches — see BROKEN. The engine itself is sound; the front door was not.

- **2026-09-03 — Deploy-key endpoint (was BROKEN #1).** Fixed in PR #258 (`id::text = $1`), deployed with `scripts/deploy-core.sh`, runner restarted, then checked against the running API on the box via `scripts/verify-deploy-key.mjs`:
  - `POST /api/projects/definitely-not-a-real-slug-xyz/deploy-key` → **404** `{"error":"project not found"}` — the lookup no longer aborts before it can miss.
  - `POST /api/projects/jarvis-proof-01/deploy-key` → **200**, real key provisioned (`fingerprint SHA256:hk1Z+fNazFajqoPF8HuQmRQJhXaVhPwPP5f/cpirxpk`).
  - Pre-fix cause confirmed against the live database, not a fixture: `SELECT ... WHERE id = 'jarvis-proof-01' OR slug = 'jarvis-proof-01'` → `ERROR: invalid input syntax for type uuid`. One placeholder was bound against a `uuid` column and a `text` column at once.
  - The same line was fixed in the PR-create and PR-merge handlers. Those two are **not** verified yet — only the deploy-key path was exercised.

## ✗ BROKEN — Tester backlog (start here)

2. **New-project dirs created as root.** `POST /api/projects` (the API container runs as root) makes `worktrees/<slug>`, `artifacts/<id>`, `browsers/<id>` owned by root; the host `jarvis` runner can't write them → every heavy task on an API-onboarded project dies with `Permission denied`. Fix: create them owned/writable by the runner user (uid 1000), or chown on create.
3. **No per-project GitHub API credential on onboarding.** A new project gets a deploy key (can push a branch) but no per-project github api credential, so it cannot open a PR, and the account-wide admin token is correctly refused. Onboarding must provision a per-project github credential (the bench path does; the API path does not).

4. **openclaw (WhatsApp) stays down once it stops — but NOT for the reason recorded.** Re-diagnosed 2026-09-03; the original entry blamed a missing restart policy and that is wrong:
   - The container already has `restart: unless-stopped`, in `deploy/compose.yaml` **and** on the live container (`docker inspect` → `{"Name":"unless-stopped"}`).
   - It did not crash. Its own log ends `[admission] closed: restart drain` / `[gateway] received SIGTERM; shutting down` / `[shutdown] completed cleanly in 398ms`, exit code **0**, `RestartCount=0`. Docker never attempted a restart because it was *explicitly stopped* — SIGTERM via the Docker API is what `docker stop` / `compose stop` sends, and `unless-stopped` deliberately does not resurrect that.
   - **`scripts/deploy-core.sh` was the suspect and has been cleared by experiment.** api and worker were `Up 3 hours` ≈ the same 12:08, so the deploy looked responsible. I started openclaw, ran a full `deploy-core.sh`, and openclaw came through it `Up 4 minutes (healthy)`. It is not the deploy.
   - So the real question is open: **what issued the stop at 12:08:08?** Nothing in `scripts/` or `jarvis-runner.service` references openclaw. Next step is the Docker daemon journal around that timestamp.
   - A restart policy is therefore not the fix. What is missing is that a deliberate stop of the input channel is **silent** — nothing notices WhatsApp is dead. That wants a health check that raises an issue, not a restart flag that is already set.

### Note for the Blockers session on B2 (I do not mark blockers cleared)
The gateway is now **Up and healthy**, and WhatsApp reconnected with **no QR scan** — the paired session in `/var/lib/jarvis/openclaw` survived the outage: `[whatsapp] [default] starting provider (+13056453617)` then `Listening for WhatsApp inbound messages`. So B2's first CHECK condition passes. The second — a test message landing as an `inbox_events` row — still needs Enrique to send one; I have not observed that.

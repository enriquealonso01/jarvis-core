# Verified on the box

Written only by the Tester/Operator session. A line here means it was watched
working on the running box — not that a local test passed.

`✓ VERIFIED` = seen working on the box, with the date and what was checked.
`✗ BROKEN`   = found broken; what and where. The Tester fixes these, redeploys, re-verifies, then flips the line to ✓.

Currently verifying: _(Tester sets this each session)_

---

## ✓ VERIFIED

- **2026-09-03 — Voice/console → task → real PR.** A plain-English instruction through `/api/inbox` became a heavy task, Claude Code reproduced a multi-file rounding bug, fixed it, added a regression test, and opened `enriquealonso01/jarvis-proof-01#1` (4 tests, 4 pass). **Caveat:** required three manual onboarding patches — see BROKEN. The engine itself is sound; the front door was not.

## ✗ BROKEN — Tester backlog (start here)

1. **Deploy-key endpoint 500s.** `POST /api/projects/:id/deploy-key` → `operator does not exist: text = uuid`. Cause: `src/product.ts` ~line 1338 `SELECT ... WHERE id = $1 OR slug = $1` — `$1` is bound against a uuid column and a text column at once. Fix: `WHERE id::text = $1 OR slug = $1` (same pattern repeats in the PR-create and merge handlers). Provisioning itself (`githubProvisionDeployKey`) is fine.
2. **New-project dirs created as root.** `POST /api/projects` (the API container runs as root) makes `worktrees/<slug>`, `artifacts/<id>`, `browsers/<id>` owned by root; the host `jarvis` runner can't write them → every heavy task on an API-onboarded project dies with `Permission denied`. Fix: create them owned/writable by the runner user (uid 1000), or chown on create.
3. **No per-project GitHub API credential on onboarding.** A new project gets a deploy key (can push a branch) but no per-project github api credential, so it cannot open a PR, and the account-wide admin token is correctly refused. Onboarding must provision a per-project github credential (the bench path does; the API path does not).
4. **openclaw (WhatsApp) does not auto-restart.** It exited 2026-09-03 ~12:08 and stayed down — WhatsApp silently dead. Fix: a restart policy (Compose `restart: unless-stopped` / systemd) so the input channel recovers itself.

_(jarvis-proof-01 was patched by hand to prove the loop; these four make the front door work on its own.)_

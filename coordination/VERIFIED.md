# Verified on the box

Written only by the Tester/Operator session. A line here means it was watched
working on the running box — not that a local test passed.

`✓ VERIFIED` = seen working on the box, with the date and what was checked.
`✗ BROKEN`   = found broken; what and where. The Tester fixes these, redeploys, re-verifies, then flips the line to ✓.

Currently verifying: _front-door items are done except the engine allowlist, which needs Enrique's design call. Next: PROGRESS.json steps marked built that have never been exercised on the box._

---

## ✓ VERIFIED

- **2026-09-03 — Voice/console → task → real PR.** A plain-English instruction through `/api/inbox` became a heavy task, Claude Code reproduced a multi-file rounding bug, fixed it, added a regression test, and opened `enriquealonso01/jarvis-proof-01#1` (4 tests, 4 pass). **Caveat:** required three manual onboarding patches — see BROKEN. The engine itself is sound; the front door was not.

- **2026-09-03 — Deploy-key endpoint (was BROKEN #1).** Fixed in PR #258 (`id::text = $1`), deployed with `scripts/deploy-core.sh`, runner restarted, then checked against the running API on the box via `scripts/verify-deploy-key.mjs`:
  - `POST /api/projects/definitely-not-a-real-slug-xyz/deploy-key` → **404** `{"error":"project not found"}` — the lookup no longer aborts before it can miss.
  - `POST /api/projects/jarvis-proof-01/deploy-key` → **200**, real key provisioned (`fingerprint SHA256:hk1Z+fNazFajqoPF8HuQmRQJhXaVhPwPP5f/cpirxpk`).
  - Pre-fix cause confirmed against the live database, not a fixture: `SELECT ... WHERE id = 'jarvis-proof-01' OR slug = 'jarvis-proof-01'` → `ERROR: invalid input syntax for type uuid`. One placeholder was bound against a `uuid` column and a `text` column at once.
  - The same line was fixed in the PR-create and PR-merge handlers. **Both now verified too — see the entry below.**

- **2026-09-03 — New-project dirs are runner-writable (was BROKEN #2).** Fixed in PR #261 (`mkdirForRunner`, inheriting the parent's owner), deployed, then verified with `scripts/verify-project-dirs.mjs` creating a real project through the running API:
  - Before: `POST /api/projects` → 200, and all three dirs `uid=0 gid=0 mode=750`; `sudo -u jarvis touch .../probe` → **Permission denied**. That is what killed every heavy task on an API-onboarded project.
  - After: all three dirs `uid=1000 gid=988 mode=750`, and `sudo -u jarvis touch` **succeeds**.
  - Probe projects use the `proj-accept-` slug prefix, so the acceptance sweep archives them.
  - **Re-confirmed in a real end-to-end onboarding** (see the end-to-end entry below): a brand-new project created through the API got runner-writable dirs with no chown by hand.

- **2026-09-03 — Onboarding through the API path, unaided, as far as the engine gate.** Run on the box with `scripts/e2e-frontdoor.mjs` after PR #270, against a brand-new throwaway repo, using **only** the API — no bench helpers, no manual patches. What actually happened, in order:
  1. `POST /api/github/admin/create-repo` → **200**, real private repo `enriquealonso01/jarvis-e2e-gbbqkr` created.
  2. `POST /api/projects` → **200**; the three dirs came out runner-owned (bug #2 holding up in a real onboarding, not just a probe).
  3. `POST /api/projects/:slug/deploy-key` → **200** with **both** `deployKeyId` and, for the first time, `apiCredentialId` (`d400d8fa…`) — bug #3's fix working on the box.
  4. `POST /api/inbox` with plain English → **200**, and it became a correctly routed task: *"task in jarvis-e2e-gbbqkr: Add money.js rounding function and test"*.
  - **Then it stopped, correctly, at a gate nobody had listed** — see BROKEN #2 below. The task sits in `waiting_for_provider` and raised `[harness] no engine is allowlisted for this project`, and notably the ticket names the *right* remedy (the per-project allowlist, not a login), which the code comment at `src/runner.ts:486` says was itself a past bug. No PR exists on the repo, and I am not claiming one.
  - **So: no manual patching was needed to onboard, and the front door is still not proven.** Steps 1–4 are real and unaided; the engine grant is a genuine missing step. This is what the monitor gate was for — three mechanisms passed in isolation and the real run found a fourth thing.


- **2026-09-03 — PR-create and PR-merge resolve by slug, and a project's OWN credential opens and merges a real PR.** These were the two things I had explicitly left unverified. Both checked against the running API on the box, on the throwaway project `jarvis-e2e-gbbqkr` from the end-to-end run.
  - **The `id::text` fix on the other two handlers** (`scripts/verify-pr-handlers.mjs`). The two 400s carry different messages, which is what makes this decisive with no side effects: `"project has no linked GitHub repo"` means the lookup missed, `"title and head branch required"` means it resolved the slug and moved on.
    - PR-create, unknown slug → **400** *no linked GitHub repo*; real slug, no title → **400** *title and head branch required*. Lookup resolves by slug.
    - PR-merge, unknown slug → **400** *no linked GitHub repo*; real slug with PR `999999` → **502** *github merge failed status=404*, i.e. it got past the lookup and reached GitHub. No 500s, no `uuid` errors anywhere.
  - **The happy path, which the end-to-end run never reached** (it parked at the engine gate first). I seeded a branch and commit on the throwaway repo, then drove Jarvis:
    - `POST /api/projects/jarvis-e2e-gbbqkr/pull-requests` → **200** `{"pr_number":1,...}`; confirmed independently with `gh pr view`: PR #1 **OPEN**, `test/pr-happy-path` → `main`.
    - `POST /api/projects/jarvis-e2e-gbbqkr/pull-requests/1/merge` → **200** `{"merged":true}`; confirmed independently: state **MERGED**, `mergedAt 2026-09-03T16:27:40Z`.
  - **This closes BROKEN #3 properly, not just at the mechanism level.** The credential used was the project's own row — `fingerprint project:jarvis-e2e-gbbqkr:github`, kind `api_key` — so an auto-provisioned per-project credential really can open *and* merge a pull request, without reaching the admin profile. Minting it was the earlier claim; this is it working.
  - **Not cleaned up, deliberately:** the repo `enriquealonso01/jarvis-e2e-gbbqkr` and its project row still exist. Deleting a GitHub repo is destructive and outward-facing, so that is Enrique's call. Its slug is not `proj-accept-*`, so the acceptance sweep will not archive it on its own.

- **2026-09-03 16:29 — WhatsApp inbound is persisted, and OpenClaw stays silent (was BROKEN #1).** Enrique sent one real message to +13056453617 and the whole chain was watched on the box:
  1. `16:29:29.582 [whatsapp] Inbound message +13055052646 -> +13056453617 (direct, 98 chars)`
  2. `16:29:29.720 [plugins] [jarvis-bridge] before_dispatch fired` — the first time either bridge hook has ever fired.
  3. `inbox_events` row `b5f7ec25-…`: `channel=whatsapp`, `sender=+13055052646`, `external_id=3ADE4FECE78695B209B6`, `capture_state=persisted`, `processing_state=processed`, `raw_text="Hi! How are you?"`, and `conversation_id` set, so it routed.
  4. `16:29:32.100 [turn/execution] visible channel turn dispatched with no queued reply payloads … cause=completed:before_dispatch_handled` — OpenClaw's own words for "the plugin took this". No `agent/embedded` run, no OpenAI 401, no reply from OpenClaw. That is ADR 002 satisfied by the runtime rather than asserted by us.
  - **What actually fixed it** was the hook, not the plumbing: `message_received` is Observe-only and could never claim a message, and `before_agent_run` never fires on this path. `before_dispatch` (Kind: *Claim*, returning `{ handled: true }`) is the one the runtime dispatches. PR #267. Capability consent (`plugins install --force --accept-capabilities`) was a genuine prerequisite but not the fix.
  - **B2's CHECK now passes** (gateway `Up`, and a real inbound produced a `whatsapp` `inbox_events` row). I do not mark blockers cleared — that is the Blockers session's call; this is the evidence for it.
  - **One loose end, not a claim either way:** the channel logged `98 chars` while `raw_text` is 16 (`"Hi! How are you?"`), and `raw_payload` is NULL on this row. The count probably covers the envelope rather than the body, but it is worth one longer message to rule out truncation before trusting long inbound text.

## ✗ BROKEN — Tester backlog (start here)

1. **No engine is allowlisted for a project onboarded through the API — the front door's last gate.** Found by the end-to-end run above, 2026-09-03, and not previously on any list.
   - A brand-new API-onboarded project reaches the harness and is refused: task parks in `waiting_for_provider` with `[harness] no engine is allowlisted for this project` (`dedupe_key harness.allowlist`).
   - **This is fail-closed by design, not a bug in itself.** `src/runner.ts:509` calls it "the per-project allowlist, which fails closed by design (S12b), so a new project has no engine until one is granted." The bench path grants it; only test scripts (`scripts/dev-seed.ts`, `scripts/fixture-teardown-test.ts`, `scripts/confidential-eligibility-test.ts`) ever insert `auth_profile_allowlists` rows, and they do it with direct SQL.
   - **There is no API endpoint to grant it.** So onboarding through the API can never finish unaided as things stand.
   - **I have deliberately not fixed this, because the two options differ in security posture and the call is Enrique's:** (a) auto-grant an engine at onboarding — makes the front door work unaided, but weakens a deliberate S12b boundary; (b) add an explicit, audited `POST /api/projects/:id/engine-allowlist` and make the grant a real onboarding step — keeps the boundary and keeps the grant a decision. **My recommendation is (b)**: granting an engine to a fresh project looks exactly like the kind of thing that should be an act, not a default. Awaiting Enrique's answer.

2. **openclaw stays down once it stops — but NOT for the reason originally recorded.** Re-diagnosed 2026-09-03; the original entry blamed a missing restart policy and that is wrong:
   - The container already has `restart: unless-stopped`, in `deploy/compose.yaml` **and** on the live container (`docker inspect` → `{"Name":"unless-stopped"}`).
   - It did not crash. Its log ends `[admission] closed: restart drain` / `received SIGTERM` / `completed cleanly in 398ms`, exit **0**, `RestartCount=0`. Docker never tried to restart it because it was *explicitly stopped* — and `unless-stopped` deliberately does not resurrect that.
   - **`deploy-core.sh` was the suspect and has been cleared by experiment.** api and worker were `Up 3 hours` ≈ the same 12:08, so the deploy looked responsible. I started openclaw, ran a full `deploy-core.sh`, and openclaw came through `Up (healthy)`. It is not the deploy. A `received SIGUSR1; restarting` at 12:05:05 shows something was signalling the gateway around then; what issued the 12:08 SIGTERM is still open.
   - So a restart policy is not the fix. What is missing is that a dead input channel is **silent** — that wants a health check that raises an issue, not a flag that is already set.
   - Gateway is currently **Up (healthy)** and WhatsApp re-paired; I restarted it 15:28 and it reconnected with no QR.

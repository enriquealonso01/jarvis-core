# Verified on the box

Written only by the Tester/Operator session. A line here means it was watched
working on the running box — not that a local test passed.

`✓ VERIFIED` = seen working on the box, with the date and what was checked.
`✗ BROKEN`   = found broken; what and where. The Tester fixes these, redeploys, re-verifies, then flips the line to ✓.

Currently verifying: _front-door. Dirs and the project API credential are proven in a real API onboarding. Blocked on two things: one real inbound WhatsApp, and Enrique's call on the engine allowlist._

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
  - **Re-confirmed in a real end-to-end onboarding** (see the end-to-end entry below): a brand-new project created through the API got runner-writable dirs with no chown by hand.

- **2026-09-03 — Onboarding through the API path, unaided, as far as the engine gate.** Run on the box with `scripts/e2e-frontdoor.mjs` after PR #270, against a brand-new throwaway repo, using **only** the API — no bench helpers, no manual patches. What actually happened, in order:
  1. `POST /api/github/admin/create-repo` → **200**, real private repo `enriquealonso01/jarvis-e2e-gbbqkr` created.
  2. `POST /api/projects` → **200**; the three dirs came out runner-owned (bug #2 holding up in a real onboarding, not just a probe).
  3. `POST /api/projects/:slug/deploy-key` → **200** with **both** `deployKeyId` and, for the first time, `apiCredentialId` (`d400d8fa…`) — bug #3's fix working on the box.
  4. `POST /api/inbox` with plain English → **200**, and it became a correctly routed task: *"task in jarvis-e2e-gbbqkr: Add money.js rounding function and test"*.
  - **Then it stopped, correctly, at a gate nobody had listed** — see BROKEN #2 below. The task sits in `waiting_for_provider` and raised `[harness] no engine is allowlisted for this project`, and notably the ticket names the *right* remedy (the per-project allowlist, not a login), which the code comment at `src/runner.ts:486` says was itself a past bug. No PR exists on the repo, and I am not claiming one.
  - **So: no manual patching was needed to onboard, and the front door is still not proven.** Steps 1–4 are real and unaided; the engine grant is a genuine missing step. This is what the monitor gate was for — three mechanisms passed in isolation and the real run found a fourth thing.


## ✗ BROKEN — Tester backlog (start here)

1. **WhatsApp inbound is never persisted — the bridge's typed hooks never dispatch.** (Was blocker B2; pairing is done, so this is purely a code/runtime fix. Highest priority: it is the front door.) Still ✗ after a session of narrowing on 2026-09-03. What is now established, on the box:
   - Inbound genuinely arrives: `[whatsapp] Inbound message +1305… -> +13056453617 (direct, 87 chars)` at 15:33:41 and 15:36:10. Gateway `health` says `WhatsApp: healthy`, no quarantines.
   - **The hooks never fire on ANY path, not just WhatsApp.** The bridge logs on every fire and no `[jarvis-bridge] message_received fired` / `before_agent_run fired` line has ever appeared. Proven independently of WhatsApp with `openclaw agent -m "hook probe"` through the gateway — the turn really ran (`health` shows session `agent:main:main`, and the turn 401s on OpenAI at the model step, i.e. it got past admission) and `before_agent_run` did not fire or block. So this is a hook-dispatch problem, not a WhatsApp-path problem.
   - Registration itself succeeds: `plugins inspect jarvis-bridge --runtime --json` → `status: loaded`, `hookCount: 2`, `hooks: [{before_agent_run}, {message_received}]`, `policy.allowConversationAccess: true`, `diagnostics: []`. `plugins doctor` passes. Config `hooks` is unset (runtime default), and the plugin's own config carries `hooks.allowConversationAccess: true`. Nothing anywhere says it is blocked — the failure is completely silent, which is why it survived this long.
   - **In OpenClaw's shipped code**, `api.on(name, handler, opts)` maps to `registerTypedHook(record, name, handler, opts, params.hookPolicy)` (`/app/dist/loader-DhyKX__3.js`), and that whole registrar is behind a conditional capability spread. Plugin hooks reach dispatch via `activatePluginRegistry` → `initializeGlobalHookRunner(registry)`, and the gate at the call sites is `hasGlobalHooks(hookName, { dispatchKind })`.
   - **Capability consent was genuinely missing and has been granted — it was not the fix.** `plugins install /plugins/jarvis-bridge --force` failed with `Plugin "jarvis-bridge" requires capability consent. Use … --accept-capabilities`. I reinstalled with `--force --accept-capabilities` (succeeded) and restarted the gateway. Hooks still do not fire. So consent was necessary but not sufficient. Note `install.acceptedSurface.hooks` still reads `[]` after consent, so that field tracks manifest-declared hook packs, not `api.on` registrations.
   - **Hook choice is still wrong, independently of the above.** The image's `/app/docs/plugins/hooks.md` lists `message_received` as **Observe** only, and says `inbound_claim` "is not a global pre-routing broadcast" (invoked only for the plugin owning the conversation binding). The hook matching the bridge's intent is **`before_dispatch`** (Kind: *Claim*) — "return `{ handled: true }` to handle it without text". `before_agent_run` is documented as working only "on a supported runner"; this path uses the embedded runner. Fixing the hook name is necessary but will not help until dispatch works at all.
   - **Correction to what this file said earlier today:** I recorded the gateway as running a *stale* bridge (`md5 59060d73…` vs repo `8f7c3cbd…`). That was wrong — the difference was CRLF only. Normalized, both copies are byte-identical (`59060d73…`); the repo copy on the box has CRLF because `deploy-core.sh` tars from Windows. The running bridge code is current.
   - **The deploy gap is real but narrower than recorded.** OpenClaw runs an *installed copy* at `/home/node/.openclaw/extensions/jarvis-bridge/`, made at install time from the bind mount `/plugins/jarvis-bridge`. `deploy-core.sh` refreshes the bind-mounted source but never re-runs `plugins install`, so a future bridge edit will not reach the gateway. It has not bitten yet only because the bridge has not changed since Sep 2. Any bridge fix must reinstall (`--force --accept-capabilities`) and restart the gateway.
   - **Since then (later on 2026-09-03):** the bridge now claims with **`before_dispatch`** and keeps `message_received` as a pure observer (PR #267, deployed). A genuinely missing piece was found and granted: `plugins install /plugins/jarvis-bridge --force` refused with `Plugin "jarvis-bridge" requires capability consent`; reinstalled with `--force --accept-capabilities` and the gateway restarted. A diagnostic at registration confirms `typeof api.on === "function"` and that all three hooks register.
   - **Retraction of my own probe:** I reported using `openclaw agent -m` to test the hooks. That probe is **not valid** for `before_dispatch` / `message_received` — they are inbound *channel* hooks and a CLI agent turn is not an inbound channel message, so it proves nothing either way for them. Only `before_agent_run`'s silence was ever real evidence, and the docs caveat that one as runner-dependent.
   - **The `whatsapp` rows already in `inbox_events` are not evidence the bridge ever worked.** They are dated 2026-09-02 22:30 with `external_id`s `vn-bad-…`, `vn-fwd-…`, `vn-spoken-…` — synthetic voice-note fixtures. No real inbound WhatsApp has ever been persisted, so there is no regression to hunt.
   - **Next:** needs ONE real inbound WhatsApp to +13056453617; none has arrived (latest inbound is 15:36, before the fix landed at 16:15). Then check for `[jarvis-bridge] before_dispatch fired`, a new `channel='whatsapp'` row, and that OpenClaw did not answer it itself. If it still does not fire, the observer separates "inbound dispatch never reaches this plugin" from "wrong hook name".

2. **No engine is allowlisted for a project onboarded through the API — the front door's last gate.** Found by the end-to-end run above, 2026-09-03, and not previously on any list.
   - A brand-new API-onboarded project reaches the harness and is refused: task parks in `waiting_for_provider` with `[harness] no engine is allowlisted for this project` (`dedupe_key harness.allowlist`).
   - **This is fail-closed by design, not a bug in itself.** `src/runner.ts:509` calls it "the per-project allowlist, which fails closed by design (S12b), so a new project has no engine until one is granted." The bench path grants it; only test scripts (`scripts/dev-seed.ts`, `scripts/fixture-teardown-test.ts`, `scripts/confidential-eligibility-test.ts`) ever insert `auth_profile_allowlists` rows, and they do it with direct SQL.
   - **There is no API endpoint to grant it.** So onboarding through the API can never finish unaided as things stand.
   - **I have deliberately not fixed this, because the two options differ in security posture and the call is Enrique's:** (a) auto-grant an engine at onboarding — makes the front door work unaided, but weakens a deliberate S12b boundary; (b) add an explicit, audited `POST /api/projects/:id/engine-allowlist` and make the grant a real onboarding step — keeps the boundary and keeps the grant a decision. **My recommendation is (b)**: granting an engine to a fresh project looks exactly like the kind of thing that should be an act, not a default. Awaiting Enrique's answer.

3. **No per-project GitHub API credential on onboarding — FIXED, see the end-to-end entry above.** A new project gets a deploy key (can push a branch) but no per-project github api credential, so it cannot open a PR, and the account-wide admin token is correctly refused. Onboarding must provision a per-project github credential (the bench path does; the API path does not).

4. **openclaw stays down once it stops — but NOT for the reason originally recorded.** Re-diagnosed 2026-09-03; the original entry blamed a missing restart policy and that is wrong:
   - The container already has `restart: unless-stopped`, in `deploy/compose.yaml` **and** on the live container (`docker inspect` → `{"Name":"unless-stopped"}`).
   - It did not crash. Its log ends `[admission] closed: restart drain` / `received SIGTERM` / `completed cleanly in 398ms`, exit **0**, `RestartCount=0`. Docker never tried to restart it because it was *explicitly stopped* — and `unless-stopped` deliberately does not resurrect that.
   - **`deploy-core.sh` was the suspect and has been cleared by experiment.** api and worker were `Up 3 hours` ≈ the same 12:08, so the deploy looked responsible. I started openclaw, ran a full `deploy-core.sh`, and openclaw came through `Up (healthy)`. It is not the deploy. A `received SIGUSR1; restarting` at 12:05:05 shows something was signalling the gateway around then; what issued the 12:08 SIGTERM is still open.
   - So a restart policy is not the fix. What is missing is that a dead input channel is **silent** — that wants a health check that raises an issue, not a flag that is already set.
   - Gateway is currently **Up (healthy)** and WhatsApp re-paired; I restarted it 15:28 and it reconnected with no QR.

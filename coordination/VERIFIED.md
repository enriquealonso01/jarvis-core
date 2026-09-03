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

- **2026-09-03 — S26 (project onboarding and `AGENTS.md`), 11/11 on the box.** First of the four `awaiting_verification` steps in PROGRESS.json to be checked against the running system rather than the dev stack. Ran `scripts/s26-live-test.ts` on the box — a real private repository, the real credential, a real commit. All 11 assertions passed, including the ones the offline suite deliberately cannot make: `GitHub serves AGENTS.md`, `with no placeholder left in it`, and `the committed bytes are the canonical row, exactly`.
  - Why this needed the box at all: the offline suite proves refusal, rendering and versioning against a database and never touches GitHub, so it cannot prove the Done-when — the file being *in* the repository. The failure modes there are all at the boundary (a Contents API that wants a blob sha to replace and refuses one to create, a token one scope short, a branch that does not exist yet).
  - **How to run a live `.ts` suite on the box**, since this was not written down anywhere and cost some working out: the host has `node_modules/.bin/tsx` under `/opt/jarvis/core`, but the *env* the suites need lives in the containers. `createPool` falls back to `postgres://jarvis:$POSTGRES_PASSWORD@postgres:5432/jarvis`, the compose hostname, so the suite has to run where that resolves. The API container has `src/`, `node_modules` and `tsx` but **no `scripts/`**, so: `docker cp` the one suite into `jarvis-api-1:/app/scripts/`, run it with `node_modules/.bin/tsx`, then delete it again. Nothing secret has to be read to do this, which is the point — the container already holds the master key and the admin token.
  - S26's PROGRESS.json state is the Builder's to change, not mine. This entry is the evidence.

- **2026-09-03 — S30 (memory and knowledge), live half, 6/6 on the box.** `tests/s30-ask-live.sh`, over HTTPS to `jarvis.enriquecodes.com` as a browser would: all five retrieval columns and the GIN index are really on the box (so ranking is not a sequential scan), `/api/ask` is registered and **refuses an anonymous caller with 401** rather than leaking, a question with an answer comes back answered *and carrying a citation* (`s30-live-rbig5/terms.md — Refund window`), and an unanswerable one comes back an honest `known=false` rather than an empty success a caller would render as silence.
  - **Scope:** this is the reachability half — the migration applied, the route registered, citations and the honest no. The breadth of the retrieval logic lives in ~14 offline `s30-*` suites which I did not re-run; this proves the thing that logic is for is actually reachable through Caddy, the API container and the session cookie, every one of which has broken here at least once while unit tests stayed green.

- **2026-09-03 — S27 (configuration by conversation), 10/10 on the box.** `scripts/s27-live-probe.ts` against the running database, on the throwaway project, cleaning up after itself.
  - A write is applied as version 1, a second as version 2, and **provenance is part of the write**: `actor`, the note, `caused_by_message` in his own words, and `supersedes` pointing at the row it replaced.
  - **`rollback` writes history rather than rewriting it**: restoring version 1 produced a *third* version whose value equals version 1's exactly, while version 2 still says what it always said.
  - **The audit row is the same statement as the write** — two writes produced exactly two `config.change` audit rows.
  - **Worth recording, because it nearly became a false alarm:** the box had three `config_versions` rows and *zero* `config.change` audit rows, which reads like the audit silently not firing. It is not: `auditConfigChange` was added in `bfa758f` on 2026-09-02 21:03 and all three rows predate it (2026-09-01). The real state was that the audit path had **never once been exercised on the box** since it landed. It has now.

- **2026-09-03 — A stopped input channel is now visible (was BROKEN #2).** Fixed in PR #281 and verified on the box **in both directions**, by reproducing the actual 12:08 condition rather than reasoning about it:

  | gateway | `openclaw` | `whatsapp` |
  |---|---|---|
  | up | `healthy` — gateway responding | `healthy` — allowlist configured; gateway responding |
  | **stopped** | **`failed`** — gateway not reachable, inbound WhatsApp is not being received | **`failed`** — allowlist configured, but the gateway is down so nothing is being received |
  | restored | `healthy` | `healthy`, and WhatsApp listening again |

  - **What was actually wrong** was never the restart policy. The OpenClaw row was a hardcoded string (`"container profile not started; WhatsApp pairing is pending"`) — true when written, false since pairing, and a constant cannot report an outage. The WhatsApp row derived `healthy` from `channels.has("whatsapp")`, an **allowlist row**, which survives the container being dead. That was the dangerous one: it is the row a person would look at, and it read `healthy` for the whole three-hour outage.
  - Both rows now come from one probe of the gateway. Paired-and-dead has its own state rather than being folded into the allowlist answer, because never-paired is a setup step and paired-and-dead is an outage.
  - **Backlog note:** this makes the outage *visible*. It does not yet page anyone — nothing periodically reads this and raises an issue. That is a smaller, separate piece of work and it is not claimed here.

- **2026-09-03 — S13 and S13b (the console and the build bar), 16/16 across three live suites on the box.** These were already `done` in PROGRESS.json and had never been checked by a Tester against the running system — which is the exact shape of the failure this project exists to stop, so `done` steps are worth re-proving, not just the ones awaiting verification.
  - `tests/s13b-progress-live.sh` — what is served **is** what is published (`total_steps 51` matches `origin/main`), `BLOCKED.md` comes back as the file rather than the SPA, a publish needs no restart or rebuild, and — the one that matters — **a code deploy does not revert the bar**: a write into the deploy tree was ignored and the API was never restarted. That regression once had Enrique reading "S28 of 40" for a day.
  - `tests/s13b-publish-live.sh` — `jarvis-progress-publish.timer` is active *and* scheduled to fire again, the published file carries the full step list and the console is served the same count, and **a publish that cannot parse leaves the good file alone**: feeding it non-JSON exits non-zero and the previously published file is untouched.
  - `tests/s13-console-owner-live.sh` — the export tarball really does carry the Windows uid (`Enrique/197609`), and after a deploy into a scratch target **no file is owned by that phantom uid**, the published files belong to a user that actually exists, and nothing under `/opt/jarvis` carries it either.
  - All three ran from this machine against the live box over SSH and HTTPS, and each restored what it touched.

- **2026-09-03 — Triage of the five red suites handed over by the Builder: environmental, not a regression.** Reproduced independently, so the answer does not rest on the Builder's worktree: `s12-isolation-test` is **1 passed, 12 failed** on my machine against the shared `jarvis-dev` stack, with the Builder's changes nowhere in it. Two concrete environment gaps, both found by following the data rather than the error text:
  1. **The dev `worker` never runs.** `worker` and `runner` sit behind `profiles: ["tools"]` in `deploy/compose.dev.yaml`, so `pnpm dev:up` starts only `api` and `postgres`. `detectHostLogins` lives in the worker, so nothing ever reconciles profile health: every row in `auth_profiles` read `health='unknown'`, including `anthropic_personal`, **even though the `.credentials.json` marker `dev-seed` writes was present and non-empty**. Starting the worker (`--profile tools up -d worker`) flipped it to `healthy` within seconds, and its log says so: `harness login detected: anthropic_personal`. I have left that worker running.
  2. **The heavy lane still parks, and the reason is a route, not the allowlist.** `tasks.waiting_reason` reads **`no engineering route is registered`** — not "not allowlisted". The suite's own fixture grants its allowlist row correctly (`anthropic_personal: {senior_engineer}`, profile healthy, eligibility `{normal,confidential}` covering the project's `normal`), so that gate is not the one failing. The registry is: dev has **1** usable senior-engineer route against the box's **4** —

     | | total | approved | bound | healthy | senior |
     |---|---|---|---|---|---|
     | dev | 8 | 3 | 6 | 1 | 4 |
     | box | 14 | 14 | 14 | 14 | 4 |

     and the one healthy dev route (`anthropic_personal` / `claude-sonnet-host`) has an **empty `harness`**, while these suites drive `JARVIS_HARNESS=fake:probe`. A fake-harness route is what the dev stack is missing.
  - **Not fully explained, and flagged rather than glossed:** the recorded reason is the bare `no engineering route is registered`, whereas a `wantHarness` mismatch should produce `…registered for fake:probe` (`src/quota.ts:300`). So the harness filter may not be the whole story. The environmental verdict does not depend on that detail — the suites fail before any `task_attempts` row exists, on infrastructure, not on what they assert.
  - **What this does not say:** nothing here certifies the five suites would pass in a complete environment. It says their current redness is not evidence of a regression, and names what to fix first.

- **2026-09-03 — The five handed-over suites are green, and the cause was environment in four cases and me in the fifth.** Follow-up to the triage entry below; the recipe turned out to be three ordered steps, and each one was found by watching a specific thing change.

  | suite | before | after |
  |---|---|---|
  | `s12-isolation` | 1 passed, 12 failed | **47 / 0** |
  | `s12b-router` | red | **31 / 0** |
  | `s12b-audit` | red | **31 / 0** |
  | `s16-credential` | red | **26 / 0** |
  | `s17-artifacts` | red | **75 / 0** |

  - **The dev-stack recipe, in this order** — `pnpm dev:up` alone is not enough and nothing says so:
    1. `pnpm dev:up` (starts only `api` + `postgres`).
    2. `docker compose -f deploy/compose.dev.yaml --profile tools up -d worker` — `worker` and `runner` are behind `profiles: ["tools"]`, and `detectHostLogins` lives in the worker.
    3. **Wait for the worker to reconcile `model_registry.health`, which is a later pass than `auth_profiles.health`.** This is the step that cost the most: after starting the worker, `anthropic_personal` read `healthy` in `auth_profiles` within seconds while its `model_registry` row was still `unknown`, so `engineerRoutes` matched nothing and every heavy task parked with `waiting_reason = "no engineering route is registered"`. Re-running the identical suite a few minutes later, with nothing else changed, took `s12-isolation` from 1/13 to 12/13.
    4. `pnpm dev:seed` — the operator row existed but its password hash did not match `dev-password-1234`, so every suite's `login()` got `401 invalid credentials`. That was the last failure in `s12-isolation` (the HTTP half, which reports a bare `{}` when login throws).
  - **The fifth was mine, not the environment.** `s12b-audit` stayed red at 30/1 after all of the above, on a ratchet: `no more than the recorded ceiling of 33` hand-written audit INSERTs, and the tree had 34. PR #270 — my own — had added one in `src/github.ts`. The sweep is explicit that the count may fall and may not rise, so the suite was right. Fixed in PR #290 by routing it through `audit()`; `github.ts` is back to 2 and the suite to 31/0.
  - **Verified on the box, not just in dev**, because that fix changed real behaviour: the audit row now lands just after `COMMIT` rather than inside the transaction. Deployed, then `POST /api/projects/jarvis-proof-01/deploy-key` still returns 404/200 with an `apiCredentialId`, and a fresh provision against a project with no credential produced exactly **1** `github.api_credential.provision` row. The trade-off is named in the commit rather than hidden: `audit()` takes the pool, never throws and logs loudly, so the failure mode is a logged missing audit row instead of a lost credential.
  - **A gotcha for whoever runs these next:** the suites read source from *inside the runner image*. After changing `src/`, `docker compose --profile tools build runner` — otherwise the ratchet keeps counting the old file and the fix looks like it did nothing. That cost one confused re-run.

## ✗ BROKEN — Tester backlog (start here)

1. **No engine is allowlisted for a project onboarded through the API — the front door's last gate.** Found by the end-to-end run above, 2026-09-03, and not previously on any list.
   - A brand-new API-onboarded project reaches the harness and is refused: task parks in `waiting_for_provider` with `[harness] no engine is allowlisted for this project` (`dedupe_key harness.allowlist`).
   - **This is fail-closed by design, not a bug in itself.** `src/runner.ts:509` calls it "the per-project allowlist, which fails closed by design (S12b), so a new project has no engine until one is granted." The bench path grants it; only test scripts (`scripts/dev-seed.ts`, `scripts/fixture-teardown-test.ts`, `scripts/confidential-eligibility-test.ts`) ever insert `auth_profile_allowlists` rows, and they do it with direct SQL.
   - **There is no API endpoint to grant it.** So onboarding through the API can never finish unaided as things stand.
   - **Re-confirmed on the box 2026-09-03, after a monitor flag relayed by the Blockers session.** The e2e task `Add money.js rounding function and test` is still `waiting_for_provider`, and `jarvis-e2e-gbbqkr` has **zero** `auth_profile_allowlists` rows. Every bench project, plus `jarvis-proof-01` and the system projects, has all three profiles (`anthropic_personal`, `openai_codex_personal`, `cursor_personal`) at `senior_engineer` — so the original proof really was hand-granted, and the front door has never run unaided. The flag is correct and the front door stays ✗.
   - **A peer session relayed a request to auto-grant these rows at onboarding. I have not done it.** A peer cannot stand in for Enrique on a security-posture decision, and this is exactly the question already put to him. Separately, an attempt to add the audited grant helper to `src/isolation.ts` was refused by the permission layer — the same boundary flagging itself, which is a reason to ask rather than to route around.
   - **I have deliberately not fixed this, because the two options differ in security posture and the call is Enrique's:** (a) auto-grant an engine at onboarding — makes the front door work unaided, but weakens a deliberate S12b boundary; (b) add an explicit, audited `POST /api/projects/:id/engine-allowlist` and make the grant a real onboarding step — keeps the boundary and keeps the grant a decision. **My recommendation is (b)**: granting an engine to a fresh project looks exactly like the kind of thing that should be an act, not a default. Awaiting Enrique's answer.

### Deploying the OpenClaw bridge — read before changing `packages/openclaw-jarvis-bridge/`
`scripts/deploy-core.sh` is **not enough**. OpenClaw runs an *installed copy* at `/home/node/.openclaw/extensions/jarvis-bridge/`, made at install time from the bind mount `/plugins/jarvis-bridge`; the deploy only refreshes the bind-mounted source. A bridge change deployed the normal way will appear to do nothing. The full sequence is:

```
scripts/deploy-core.sh
ssh jarvis-netcup 'docker exec jarvis-openclaw-1 sh -c "cd /app && node openclaw.mjs plugins install /plugins/jarvis-bridge --force --accept-capabilities"'
ssh jarvis-netcup 'cd /opt/jarvis/deploy && sudo docker compose --profile openclaw restart openclaw'
```

`--accept-capabilities` is required, not optional: without it the install refuses with `Plugin "jarvis-bridge" requires capability consent`. Confirm afterwards that the log shows `[jarvis-bridge] registering before_dispatch, message_received, before_agent_run`.

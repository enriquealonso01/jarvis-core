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

- **2026-09-03 — S12b item 5: the harness cannot reach Jarvis, proved at the network layer. 14/14 on the box.** `scripts/s12b-egress-live.ts`, run on the host as the `jarvis` user, through the *same* wrapper the runner spawns the harness with rather than a copy of it. It needs `unshare` and `slirp4netns` and a real Jarvis to fail to reach, so it cannot be faked in a dev stack.
  - Refused **at the network layer**, not by application logic — `000REFUSED`, not a 403: `/internal/*`, Postgres, the API container direct on the Docker network (172.18.0.3), the host through slirp's alias, and the Docker socket. The runner's user is confirmed not in the `docker` group.
  - What makes it worth trusting is the controls: the same addresses **do** answer 200 from the host, and Postgres really is listening. So the refusals are containment rather than a broken probe — an all-refused result with no control would prove nothing.

- **2026-09-03 — Operational: the host runner was running stale code, and I put it there.** Caught by comparing timestamps rather than by anything failing.
  - `jarvis-runner` had started 18:21 CEST while `/opt/jarvis/core/dist/runner.js` was rebuilt at 19:08 — 47 minutes of drift. Cause: I had used `scripts/deploy-core.sh --no-runner` repeatedly (correctly, to avoid killing work in flight) and then not come back to restart it. The flag exists for a real reason; forgetting the second half is the failure mode it creates.
  - Restarted with nothing in flight (`0` tasks `running`/`preparing`/`claimed`), and confirmed by timestamp rather than by assumption: runner now starts 19:11:08, ahead of the 19:08:13 build.
  - **Standing rule for this session:** after any `--no-runner` deploy, either restart the runner before finishing or record that it is deliberately deferred. A process holding old code in memory is exactly the class of bug this project keeps finding, and it is invisible unless the timestamps are compared.

- **2026-09-03 — The backup did not contain the knowledge corpus. Found, closed, and re-proved on the box.** `scripts/restore-drill.sh` — which restores the latest snapshot into an isolated directory, loads the dump into a throwaway database and asserts the rows come back.
  - **First run FAILED:** `knowledge_chunks — 69 rows live, none restored - not in this backup`. Everything else restored, including decrypting a canary credential with the restored key.
  - **Diagnosed rather than assumed.** The dump was `pg-20260903T001501Z`, taken at 00:15 UTC; the `knowledge_chunks` migration landed 05:05 and the first row appeared 11:42. So this was not a backup *defect* — the table did not exist when the snapshot was taken. It did mean something real: **no existing backup contained the knowledge corpus**, nor ~13 hours of tasks and memory, and the next scheduled backup was hours away.
  - **Why nobody would have noticed:** backups run daily (02:15 local) but the restore drill runs **monthly** — `0 5 1 * *`. The gap would have gone unseen until October 1.
  - **Closed it:** ran `jarvis-restic-cron` immediately. New snapshot `79bcbdff` at 19:17, 908 MiB against the previous 716 MiB.
  - **Re-proved it:** the drill now reports `restore-drill ok` — 13/13, `knowledge_chunks 69 rows restored (69 live)`, `memory_items 188/188`, every restored chunk has a tsvector, and the canary credential decrypts with the restored key (fingerprints only, never a secret).
  - **Worth saying plainly:** the drill did its job. A monthly cadence on the one check that proves the backups are real is thin for a system whose schema changes several times a day, and that cadence — not the backup — is the thing worth revisiting.

- **2026-09-03 — The heavy lane refused to fix a bug that did not exist, and it was right. Watched on the box.** This was not the run I intended and it is better evidence than the one I intended.
  - I seeded a repository with what I believed was a rounding bug and reported it through `/api/inbox`: *"totalWithTax(0.60, 0.025) returns 0.61 instead of 0.62"*. The task ran end to end on an API-onboarded project and came back **`not_reproducible`**, parked in `waiting_for_user`, with a trace: `0.60 + 0.60*0.025 = 0.61499999999999999112` (a double just below 0.615), and on multiplying by 100 that lands on exactly `61.5`, which rounds **up**. It returns `0.62` — the correct answer.
  - **I checked the claim myself rather than believing the machine.** `node -e` reproduces its arithmetic exactly: `(0.60+0.60*0.025)*100 = 61.500000000000000000`, and `totalWithTax(0.60,0.025) === 0.62`. **The report was mine and it was wrong.**
  - **Why this is worth recording as a pass:** rule 1 of the harness prompt is *"If you cannot REPRODUCE the problem, stop and say so. Do not fix what you cannot see failing"*, and rule 2 is that a guess dressed as a fix is worse than nothing. Faced with an authoritative-sounding bug report from the operator, it declined, showed its arithmetic, and parked for a human. A system that invents a plausible fix for a non-existent bug is far more dangerous than one that fails loudly, and this is the first time that behaviour has been observed on the box rather than asserted in a prompt.
  - **What it does not do is certify the front door**, which requires reaching a real PR. The fixture was invalid, so the run could not get there. Re-reported with a genuine defect — `roundCents(1.005)` returns `1` where `1.01` is right, and `roundCents(8.165)` returns `8.16`, because `1.005*100 = 100.49999999999998579` — including the detail that `money.test.js` currently asserts the wrong value, so the seeded test is itself part of the bug.

- **2026-09-03 — ✅ THE FRONT DOOR, END TO END ON THE BOX: plain English in, a real reviewed pull request out.** `enriquealonso01/jarvis-e2e-3e4adc11` **PR #1**, branch `jarvis/task-02902a67` — https://github.com/enriquealonso01/jarvis-e2e-3e4adc11/pull/1
  - **The whole chain, watched rather than inferred:** `POST /api/github/admin/create-repo` → 200 · `POST /api/projects` → 200 · `POST /api/projects/:slug/deploy-key` → 200 with both `deployKeyId` and `apiCredentialId` · the engine grant (see below) · `POST /api/inbox` with a plain-English bug → 200, routed to *"task in jarvis-e2e-3e4adc11: Fix roundCents half-cent rounding in money.js"* · `engineer ladder chose anthropic_personal (subscription, claude_code)` · the harness ran inside `unshare -rn` with the private ranges unreachable · task `succeeded` · branch pushed · **PR opened**.
  - **The engine grant is a DELIBERATE ONBOARDING STEP, not a missing feature.** Per the B3 ruling, onboarding does not auto-grant engines — fail-closed per S12b and "no automatic paid API enablement". Enrique ran the grant himself; the three profiles were verified present on the box before the run. Nobody should later read this as a gap and "fix" it by auto-granting.
  - **The PR is a real fix, checked rather than trusted.** It names the cause (`1.005 * 100 === 100.49999999999999`, so scaling drifts just below the half-cent boundary), fixes it by re-parsing at 15 significant digits, **corrects the wrong assertion the seeded `money.test.js` baked in** (`roundCents(1.005)` asserted as `1.0`), and adds a case for `8.165 → 8.17`. I ran the proposed implementation independently: it holds for `1.005`, `8.165`, `0.615`, `1.0`, `2.675` and `1.004`, including cases the PR does not test.
  - **This closes the gap the whole coordination scheme exists to catch** — 28 rows marked `done` over a front door that had never once run. It has now run, unaided past the one deliberate grant, on a repository that did not exist an hour earlier.
  - **The evidence, copied in full because the artefact may not outlive the record.** Deleting the throwaway repository would 404 the link above, so the proof lives here rather than only there. PR #1 · branch `jarvis/task-02902a67` · commit `9ab2c87fe685` · *"Fix roundCents rounding half-cent boundaries down"*. The diff Jarvis produced, unedited:

```diff
diff --git a/money.js b/money.js
index 779dd01..60fbcd3 100644
--- a/money.js
+++ b/money.js
@@ -1,6 +1,13 @@
 export function roundCents(amount) {
   // Rounds a money amount to whole cents.
-  return Math.round(amount * 100) / 100;
+  //
+  // Scaling by 100 can leave the result just below a half-cent boundary
+  // (e.g. 1.005 * 100 === 100.49999999999999) because the input is not
+  // exactly representable in binary floating point. Re-parsing at 15
+  // significant digits snaps that drift back to the true boundary so
+  // Math.round rounds the half cent up rather than truncating it.
+  const scaled = Number((amount * 100).toPrecision(15));
+  return Math.round(scaled) / 100;
 }
 
 export function totalWithTax(amount, rate) {
diff --git a/money.test.js b/money.test.js
index dcdf213..7336a33 100644
--- a/money.test.js
+++ b/money.test.js
@@ -3,5 +3,9 @@ import assert from "node:assert";
 import { roundCents } from "./money.js";
 
 test("rounds whole cents", () => {
-  assert.strictEqual(roundCents(1.005), 1.0);
+  assert.strictEqual(roundCents(1.005), 1.01);
+});
+
+test("rounds half-cent boundaries up", () => {
+  assert.strictEqual(roundCents(8.165), 8.17);
 });
```

  - **Every front-door bug in the original backlog is now verified fixed on the box:** the deploy-key 500 (uuid/text), root-owned project dirs, the missing per-project GitHub credential, and WhatsApp inbound never persisting.

- **2026-09-03 — Box brought up to `main` (aa5ad42), and smoke-checked after.** The box was one build behind: it had `connectors.ts`, `mcp.ts` and `tools.ts` but not `connections.ts` from PR #296, so the S31 work on `main` was not actually running anywhere.
  - Deployed with nothing in flight (`0` tasks `running`/`preparing`), **including the runner this time** — started 19:38:38 against a 19:37:57 build, checked by timestamp per the standing rule rather than assumed.
  - After: all five containers up, `/api/health` 200, `PROGRESS.json` 200 over HTTPS, and **openclaw came through the deploy again** (51 minutes' uptime), which is now the third independent confirmation that `deploy-core.sh` does not stop it.
  - **Console smoke over HTTPS:** `/` and `/tasks` 200; `/approvals`, `/artifacts`, `/calls` are 308s that follow to their trailing-slash form and return 200 — benign static-export routing, checked rather than assumed from the status code. `/404.html` 200.
  - **The auth gate still holds anonymously:** `/api/projects`, `/api/inbox` and `/api/operations/services` all 401 unauthenticated.
  - **Operational note for whoever deploys next:** the console has **no source in this repository**. `/opt/jarvis/control-center` is a built export and `scripts/deploy-control-center.sh` takes a prebuilt tarball, so the console cannot be rebuilt from `jarvis-core` alone. Worth knowing before someone assumes a console fix is a code change away.

- **2026-09-03 — Checked `main` is green after the S31 merges, and separated a real pass from an environmental red.** Dev images rebuilt against `main` first (api, runner and worker — the suites read source from *inside* those images).
  - **Green:** `s31-connector-test` **16/0** — the newest work, so the thing most likely to have broken — and `s9-review-test` **24/0**.
  - **Red, and environmental rather than a regression:** `s2-task-create-test` and `s3-routing-test`. Every routing case came back `ambiguous` while the decision was still timestamped, i.e. the pipeline runs and the classification never happens. Cause: the dev stack has **no usable `supervisor` model**. Its only `approved` supervisor route is `s12_beta_mtlrz9kl` (`degraded`) and `fireworks` sits at `unknown`/`discovered`, so there is nothing to route with.
  - **The box is not affected, and I checked rather than assuming.** Its `model_registry` holds 14 legitimate rows — `fireworks`, `anthropic_personal`, `groq`, `nvidia`, `elevenlabs`, `openai_codex_personal`, `cursor_personal`, `google_ai` — all `approved`, with **healthy `supervisor` routes**. No fixture rows. Routing demonstrably works there: 8 `supervisor.route` audit events in six hours, and every `/api/inbox` message I sent today was classified and routed to a task in the right project.
  - **Small finding worth knowing:** `s12_beta_mtlrz9kl` is **test litter in `model_registry`** — a suite left behind an `approved` row carrying the `supervisor` role. `no-test-litter-test` passes, so it does not cover `model_registry`. Dev-only today and no production impact, but a fixture that can leave an approved routing row behind is the kind of thing worth catching before it happens somewhere that matters.

- **2026-09-03 — Operational sweep of the box: healthy, with one pattern worth naming.** Nothing was broken; this is the check that says so with evidence rather than silence.
  - **Scheduled machinery is alive:** 9 systemd timers, **zero failed units**. `jarvis-progress-publish.timer` and `jarvis-watchdog-backstop.timer` both firing on a ~5 minute cadence, last runs 4m31s and 1m31s ago.
  - **The watchdog is not merely firing, it is completing:** `component_sweeps` shows the `watchdog` component last completed **0.085 seconds** before the query, across 10,275 sweeps. A timer that fires while the work it guards has stopped is the failure this table exists to catch, so it is worth reading the table rather than the timer.
  - **No stuck work:** zero tasks in `running`/`preparing` with an expired lease; 299 tasks succeeded in 24 hours against 8 `failed_terminal` and 2 `stalled`.
  - **Every open issue is historical, and I checked rather than assuming:** the 2 `security.isolation` issues are both from `s28-parity-*` fixture projects at 01:48 and 02:06 — the guard **correctly** firing during a parity run, not a production breach. The 6 `harness.crash` issues are all Sep 1–3 against `s28-parity-*` and `whatsapp-integration`, none newer than 01:43. Nothing has crashed since.
  - **The pattern worth naming:** test fixtures leave `open` issues behind on the **production** box, and this is now the third form of the same thing — the zombie `waiting_for_provider` task I cancelled, the `approved` supervisor row left in dev's `model_registry`, and now 8 open issues owned by fixtures that no longer exist. None is harmful alone. Together they are exactly the noise a real incident hides in: an operator scanning open issues sees fixture debris and learns to skim. Worth a teardown that closes what it opened.

- **2026-09-03 — Production is carrying schema that exists in no commit. Found, mechanism identified, further leakage stopped.** The box had **50 migrations applied against 47 in `main`**, and nothing in `main` unapplied. The three extras:
  - `045_outbox_dropped.sql` — an **untracked file**. In no branch, no commit; the only copy was in a working tree on one laptop. **My own deploys shipped it**, repeatedly, and the API applied it.
  - `041_connection_actions.sql`, `042_mcp_tools.sql` — from `feat/s31-connector-interface`, **never merged**. They left `connection_actions` and `mcp_tools` on the box: real tables that **no migration in `main` creates and no code in `main` references**.
  - `044_outbox_handed_off.sql` — from `fix/outbox-delivery-loop`, also unmerged.
  - **The mechanism:** `scripts/deploy-core.sh` packs the **working tree**, not a git ref — deliberately, because the tree is the image build context. So whatever sits on disk when someone deploys becomes production schema, and `MIGRATIONS_DIR=/app/migrations` applies it on start. A later deploy from `main` neither notices nor undoes it: the file vanishes from the tree while the `schema_migrations` row and the table remain.
  - **No active conflict, and I checked rather than assuming the worst.** `main`'s `046_connection_actions.sql` takes a different design — `ALTER TABLE connections ADD COLUMN permitted_actions text[]` — instead of creating the orphan table, so nothing collided. This is dead schema, not broken schema. The danger was never today; it is the next migration that picks a colliding name.
  - **Fixed the leak** (PR #309): `deploy-core.sh` now refuses to deploy when `migrations/` has uncommitted changes, with `DEPLOY_ALLOW_DIRTY_MIGRATIONS=1` for someone who means it. Scoped to `migrations/` alone, because that is the one directory where the mistake cannot be walked back — everywhere else a dirty tree is the normal cost of iterating, which is why the script packs the tree at all. `045` has been moved out of the tree (copy kept) so it stops shipping.
  - **Not done, deliberately:** dropping `connection_actions` and `mcp_tools` and their `schema_migrations` rows is destructive work on the production database. That is Enrique's call, not mine. Until then the box keeps two dead tables — inert, but they should not be discovered by someone in six months wondering what created them.

- **2026-09-03 — The deploy guard I shipped actually blocks, verified both ways.** A guard that is never tested is a comment, so I tested my own fix rather than trusting the diff.
  - **Refuses:** dropped an untracked `migrations/999_guard_probe.sql` into the tree and ran `deploy-core.sh` — it printed the refusal, named the offending file, and **exited 1**. The exit code is the part that matters and it is easy to get wrong; my first check read `head`'s status through a pipe and reported a misleading `0`, so I re-checked the script's own status directly.
  - **Does not false-positive:** with `migrations/` clean the script ran end to end — build, containers, runner restarted 20:03:09 against a 20:02:28 build, `/api/health` 200.
  - **Current drift, for the record:** 50 migrations applied on the box against 46 in `main`. The gap is now four — `041_connection_actions`, `042_mcp_tools`, `044_outbox_handed_off`, `045_outbox_dropped` — and it widened by one purely because `045` was removed from the tree, which is the intended direction: nothing new can leak, and what already leaked is now counted rather than hidden.

- **2026-09-03 — S32 is green across all five suites: 88 assertions, 0 failures.** Dev images rebuilt against `main` first (api, runner, worker). `s32-origin-test` 10/0, `s32-browser-gate-test` 22/0, `s32-mode2-test` 18/0, `s32-session-test` 18/0, `s32-tiers-test` 20/0. This is the newest work in the tree, so the most likely to be broken, and it is not.

- **2026-09-03 — The test-litter cleanup covers fixture projects but not the case I reported.** The Builder shipped `scripts/clear-test-litter.ts` and a teardown-in-`finally` after I named the pattern, which is the right response — its docstring puts the reasoning better than I did: *"a leftover fixture is a live routing target"*.
  - **It works for projects:** the tool reports `0 fixture project(s) of 14` on dev, and it is deliberately conservative — matching only machine-generated slugs after an earlier cleanup deleted the seeded `alpha-web` and took a suite from 2 failures to 11.
  - **The row I actually reported is still there:** `s12_beta_mtlrz9kl` remains in `model_registry` as `approved`, `degraded`, carrying the `supervisor` role. Neither `scripts/clear-test-litter.ts` nor `scripts/lib/fixture.ts` mentions `model_registry` at all — **zero references in each**.
  - **Why that specific row matters, by the tool's own argument:** `approved` plus `degraded` is *selectable* — route lookups accept `health IN ('healthy','degraded')` — so a fixture has left behind a live, selectable supervisor route with no real credential behind it. That is precisely the "live routing target" the cleanup exists to prevent, in a table the cleanup does not look at.
  - Dev-only today; the box's `model_registry` is clean (14 legitimate rows, checked). Recorded rather than fixed, because a fixture-teardown change belongs to the Builder's lane, not mine.

- **2026-09-03 — S32 deployed to the box and its schema verified there; behaviour is still only proved in dev, and that is worth saying out loud.** Deployed `main` (51 migrations applied, runner restarted 20:12:32 against a 20:11:48 build, `/api/health` 200, all four S32 source files present).
  - **On the box:** `browser_actions` and `browser_sessions` exist, and migration `052_artifact_origin` genuinely took effect — `artifacts.origin_url text` is there, not merely recorded as applied. Checking the column rather than the migration row matters: `ADD COLUMN IF NOT EXISTS` will happily mark itself done against a table that already had it.
  - **The honest limit:** S32 registers **no HTTP routes** — it is internal machinery reached through the harness and a browser — so there is nothing on the box I can exercise from outside the way I could with `/api/ask` or `deploy-key`. Its behaviour rests on the five dev suites (88 assertions, 0 failures) plus the schema check above. That is weaker than "watched it work on the box", and I am recording it as such rather than letting a green suite count as a box verification.
  - What would close the gap is a live suite that drives a real browser session on the box, in the shape of `s26-live-test` or `s30-ask-live`. None exists yet; that is a Builder-lane gap, noted not claimed.

- **2026-09-03 — Found and fixed a real defect in both closed reason lists, on the box.** The phone's "closed list of six reasons to ring" accepted fifteen strings, and WhatsApp's eight accepted fifteen.
  - **How it was found:** S33 landed, and anything that can start a conversation unbidden is worth probing rather than reading. I exercised the **deployed** `dist/` on the box — not the repo, not a fixture — with junk reasons. `mayOpenConversation("__proto__")` returned `send: true`. `mayDial("__proto__")` returned `ring: true` — **the phone would have rung**.
  - **Cause:** both guards asked `reason in LIST`. `in` walks the prototype chain, so `__proto__`, `constructor`, `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf` and `propertyIsEnumerable` all satisfied a check whose whole purpose is that everything else is refused. S23's own comment says the check lives at the dial site because *"a check that lives in a form is a check that a background job walks past"* — this was the same failure one level down: the check was in the right place and answered the wrong question.
  - **Fixed** in PR #317 with `Object.hasOwn`, which asks the question both call sites meant, and **re-verified against the redeployed code**: all seven inherited names now `ring=false` / `send=false`, while `security_event` still rings and `blocker` still sends. `s33-unprompted-test` 19/0 and `s23-outbound-test` 5/0 both still pass.
  - **Severity, stated honestly:** no caller passes these strings today, so nothing was ringing wrongly and no message was sent that should not have been. The guard simply was not the guard it claimed to be. It is worth being exactly right because what it guards is Enrique's phone at three in the morning, and because both suites were green over it — 24 assertions across two files, none of which asked whether the list was actually closed.

- **2026-09-03 — Swept for the rest of the inherited-key class and found three more, all on the box.** Having found the reason-list bypass, the question was whether it was one mistake or a habit. It was a habit: a grep for the *shape* — an object indexed by a runtime string — turned up ten candidates, of which three were real.
  - `artifacts.canTransition("constructor", …)` and `callstate.canMove("constructor", …)` both **threw** `(NEXT[from] ?? []).includes is not a function`. The `?? []` fallback never fires for an inherited key, because the index returns something truthy. **A state machine asked about an unknown state must answer no; throwing turns a clean refusal into a 500.**
  - `immutableDomain("constructor")` returned the **Object constructor** where the signature promises `string | null` — a value that then travels into a refusal's `domain` field and an audit row. This one failed *closed* (truthy means immutable), so nothing was ever wrongly permitted.
  - **The most interesting part is an accident.** `immutableDomain` lowercases its key first, so `toString` becomes `tostring` and stops matching. Only `constructor` and `__proto__` survive unchanged. Most of the class was hidden by a coincidence that has nothing to do with safety, and would stop being true the moment someone adds a lowercase key. That is worth more than the three fixes: the codebase was protected by luck in a place it believed it was protected by a check.
  - Fixed with `Object.hasOwn` (PR #320), deployed, and **re-verified against the redeployed code**: all three now refuse cleanly, and `immutableDomain("spend_ceiling_cents")` still returns `spend ceilings`. `s17-artifacts` 75/0, `s19-call` 41/0, `s27-config` 85/0.
  - The other seven candidates were checked and left alone — their keys are hardcoded at every call site, so there is nothing to bypass. Recorded so nobody re-greps the same list.

- **2026-09-03 — The same inherited-key bug a fifth time, in the deletion allow-list. Found, fixed, re-verified on the box.** S34 landed and I probed it rather than read it, because it is the module the plan itself calls the most dangerous: *"the self-repair's cheapest lever is deleting his data"*, running unattended at three in the morning against the corpus S30 answers from.
  - `planReclaim` decided what may be deleted with `c.kind in RECLAIMABLE`. Against the deployed code on the box: **`constructor`, `__proto__` and `toString` were approved for deletion**, while `knowledge_chunks` was correctly refused. The real logic worked — the case the module exists for behaved — and anything inherited walked straight past the allow-list whose own comment calls the refusals *"the load-bearing half"*.
  - Fixed with `Object.hasOwn` (PR #322), deployed, **re-verified against the redeployed code**: `approved: build_caches` alone, `bytesReclaimable = 10`, with `knowledge_chunks`, `constructor`, `__proto__` and `toString` all refused. `s34-maintenance-test` 18/0.
  - **Five instances of one mistake now:** the phone's reason list, WhatsApp's, two state machines, and the deletion allow-list. Each was individually harmless — no caller passes these strings — and each was a guard that did not guard. A grep for the shape now returns **zero** bare membership tests in `src/`, which is the only reason I am not expecting a sixth.
  - **What I would rather see than my auditing:** every one of these is `SOMETHING in LIST` where `LIST` is an object literal used as a set. A `Set`, or a lint rule banning `in` against a const object, removes the class rather than the instances. That is a Builder-lane call; recorded, not done.

- **2026-09-03 — S34 disk thresholds probed on the box; two small real defects, fixed and re-verified.** A different angle on the same dangerous module: boundary arithmetic rather than key lookups, since `usedRatio` is what decides whether the 3am deletion runs at all.
  - **Fail-open on an unmeasurable disk.** `usedRatio` answers 0 for a non-positive total — correct on the prune side, because a garbage reading must not start deletions — but `mayAcceptUpload` read that as "0% used". Observed on the box: `totalBytes=0` accepted a **1e12-byte upload**. A disk we cannot measure is not an empty disk, and the module's own rule is that refusing is recoverable while accepting is not. Now both sides fail safe.
  - **A comment that said the opposite of its constant.** `INGEST_REFUSE_AT` was documented *"Below the prune threshold on purpose"* while being `0.90` against `PRUNE_AT = 0.85`. I checked the behaviour before believing the comment, and the **ordering is correct**: pruning removes only rebuildable or expired debris, so it is cheap and goes first; refusing his uploads is the harsher measure and waits. The sentence was simply wrong — and on a safety threshold that is a trap, because the next person to move one will trust it.
  - **What I checked and did not change:** the 85–90% band, where pruning runs while uploads are still accepted. That reads like the "accepted and quietly pruned later" case the plan rules out, but it is not — `planReclaim` refuses his data, so the only thing pruned in that band is debris. Recorded because it looks wrong at a glance and the next reader deserves the answer rather than the alarm.
  - Fixed in PR #325, deployed, **re-verified against the redeployed code**: unmeasurable disk refuses a 1TB upload with a truthful reason, a healthy disk still accepts, a 90%-full disk still refuses, thresholds unchanged. `s34-maintenance-test` 18/0.

- **2026-09-03 — S33 staleness classification verified on the box; the three *behaviours* are not built yet, and that is in-progress work rather than a defect.**
  - **What is real and correct:** `stalenessFor` returns `wait` / `re-raise` / `block` for the 16 classified categories, an unclassified category defaults to **`re-raise`** rather than `wait` — deliberately, since "the backup that has been failing for a month, silent because nobody wrote a row for it" is the failure a `wait` default would cause — and every inherited key (`toString`, `constructor`, `__proto__`, `valueOf`) also lands on the default. Distribution: 6 `wait`, 7 `re-raise`, 3 `block`.
  - **The Builder had already hardened this one**, with a comment naming the exact failure I had been finding elsewhere: an inherited key returns a truthy *function* where the signature promises a `Staleness`, and that value lands in `issues.staleness`, which carries a CHECK constraint — so it would turn a classification into a database error at the moment an Issue was being raised about something else. Worth recording that the lesson propagated ahead of me rather than my having to find a sixth.
  - **What is not built:** the plan is emphatic that these must be three *behaviours* — *"All three, or the policy is one behaviour with three names."* Today `stalenessFor` has exactly one consumer (`maintenance.diskStaleness`), nothing branches on the three classes, and `issues.staleness` is NULL for all 537 rows on the box. **This is not a finding.** S33 and S34 are both `in_progress`, so the wiring is simply still being written.
  - **The property to test when it lands**, recorded now so it is not invented after the fact: a `wait` item must never nag, a `re-raise` item must reappear in the weekly report with its age, and a `block` item must actually stop something. If all three merely file an Issue, the plan's own sentence says that is a failure however green the suite is.

- **2026-09-03 — Regression sweep over my own changes: 10 suites, 376 assertions, 0 failures.** I have edited six source files in the last few ticks — `outbound.ts`, `unprompted.ts`, `artifacts.ts`, `callstate.ts`, `config.ts`, `maintenance.ts` — and had only run the suite nearest each change. That is how a fixer becomes the next defect, so this checks the neighbours rather than the patch.
  - Chosen for adjacency, not convenience: the call path because `callstate.canMove` is a transition guard the whole call machinery leans on, and the rest because they cover the files directly.
  - `s19-call` 41/0 · `s20-turntaking` 52/0 · `s21b-call-defects` 35/0 · `s24-callreview` 34/0 · `s25-routing` 12/0 · `s17-artifacts` 75/0 · `s27-config` 85/0 · `s23-outbound` 5/0 · `s33-unprompted` 19/0 · `s34-maintenance` 18/0.
  - Dev images (api, runner, worker) rebuilt against `main` first, so the suites read the current source rather than a cached image — the mistake that once cost a confused re-run.
  - Box brought to the same commit afterwards: runner restarted 20:44:39 against a 20:44:31 build, `/api/health` 200, five containers up.

- **2026-09-03 — Three live failure classes have no notification entry and are silently classified as `worker.crash`.** Found by re-testing an assumption of my own: I had dismissed `notify.classify` as safe because "the keys are hardcoded". That dismissal was correct — `verdict.errorClass` is a typed union built from literals, so it cannot be an inherited key — but checking it properly raised the better question, which is whether every class in the taxonomy actually *has* an entry.
  - `POLICY` in `failures.ts` defines 10 retry/park classes; `ERROR_CLASSES` in `notify.ts` defines 35 notification entries. Three of the ten are **absent from the notification table**: `agent.repeat`, `dependency.unavailable`, `resource.cpu`.
  - **They are not rejected — they fall through.** On the box, `classify()` gives all three `severity=high, notify=ui_only, retryable=true, limit=3`, which is `worker.crash`'s row. The fallback is documented and sane *for an unknown category*; the point is that these are not unknown. They are known members of the taxonomy that were never given an entry, so a default meant for strangers is being applied to family.
  - **One of them fires in production:** `agent.repeat` has 2 open issues on the box, the most recent today. So this is live behaviour, not a hypothetical.
  - **A disagreement between two tables worth someone's judgement:** `resource.cpu` is classified `re-raise` by `staleness.ts` — the class for things that get *worse* while they wait — while inheriting `notify: "ui_only"`, which never reaches WhatsApp. Something that degrades unattended but is only ever shown in a console is the shape the staleness work exists to prevent.
  - **Recorded, not fixed.** Choosing a severity and a notification channel per class is a policy decision, and inventing three of them to make a table look complete would be exactly the kind of confident guess this project keeps catching. It needs the Builder or Enrique.

## ✗ BROKEN — Tester backlog (start here)

_Empty as of 2026-09-03. Every item that was on this list — the deploy-key 500, root-owned project dirs, the missing per-project GitHub credential, WhatsApp inbound, and the silent dead input channel — is verified fixed on the box above. The engine grant is **not** an open item: per B3 it is a deliberate onboarding step, by design.

Still outstanding, but not broken: **S23** (`Jarvis calls Enrique`) is unverified because its live test places a real Telnyx call and spends credit — it needs Enrique's go-ahead, not a fix. The same applies to `s28-parity-live`, `s37-ingest-live` and `s22-live-call-to-pr`, which spend model or telephony budget._


### Deploying the OpenClaw bridge — read before changing `packages/openclaw-jarvis-bridge/`
`scripts/deploy-core.sh` is **not enough**. OpenClaw runs an *installed copy* at `/home/node/.openclaw/extensions/jarvis-bridge/`, made at install time from the bind mount `/plugins/jarvis-bridge`; the deploy only refreshes the bind-mounted source. A bridge change deployed the normal way will appear to do nothing. The full sequence is:

```
scripts/deploy-core.sh
ssh jarvis-netcup 'docker exec jarvis-openclaw-1 sh -c "cd /app && node openclaw.mjs plugins install /plugins/jarvis-bridge --force --accept-capabilities"'
ssh jarvis-netcup 'cd /opt/jarvis/deploy && sudo docker compose --profile openclaw restart openclaw'
```

`--accept-capabilities` is required, not optional: without it the install refuses with `Plugin "jarvis-bridge" requires capability consent`. Confirm afterwards that the log shows `[jarvis-bridge] registering before_dispatch, message_received, before_agent_run`.

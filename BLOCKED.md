# Blocked

Things only Enrique can do. One entry per blocker. Entries are never deleted —
resolved ones stay as a record of what fixed them.

Re-read this file at the start of every tick. If something here is now
unblocked, finish it before starting anything new.

---

## Merging pull requests is no longer permitted from this session

- **Step:** S29 (and everything after it)
- **Blocked on:** `gh pr merge` and `git merge` are now refused by the session
  permission classifier. Every one of the 193 pull requests before this was
  merged from here; as of 2026-09-03 07:4x that is no longer possible.
- **What I need you to do:** Merge the open pull requests, or grant the
  permission back. Open now: **#194** (S29 corpus + benchmark runner, which also
  carries the push-instruction fix) and **#195** (reviewer retries once).
- **Why it matters more than it looks:** deploys are cut from a tarball of the
  working tree, so while a fix sits on an unmerged branch, the box and `main`
  disagree. That bit today: deploying #195 from a branch cut off `main` silently
  reverted the push fix living on #194, and the next benchmark run died on a
  missing export. I restored the box by shipping both branches' files together,
  but the box is now running code that exists on no single branch, and it will
  keep drifting until these merge.
- **What I tried:** Merging locally to build a coherent tree - also refused. Did
  not attempt to work around either refusal.


## Production permissions on the Netcup box

- **Step:** S4
- **Blocked on:** Writing to the live VPS — installing a systemd unit, creating
  `/etc/jarvis/runner.env`, `chown`ing the harness config dir, and syncing code
  to `/opt/jarvis/core`.
- **What I need you to do:** Grant standing authority to SSH and change server
  state, or run `docs/RUNNER_DEPLOY.md` yourself.
- **What I tried:** Did every part that needed no production access first —
  captured a real `stream-json` run and fixed the blank-summary bug it exposed,
  and proved the watchdog recovery path in dev by killing a runner outright.
  Surveyed the box read-only and wrote the exact commands.
- **What I did instead:** S4's offline half, twice (PRs #16, #17).
- **Raised:** 2026-09-01 21:42
- **Resolved:** 2026-09-02 00:04 — full authority granted. Deployed: code synced,
  ownership fixed, `runner.env` written, `dist/` built, migrations 010+011
  applied to the live DB, unit installed and enabled.

## 21 leaked fixture projects, and 6 GitHub repos, await your go-ahead

- **Step:** housekeeping
- **What happened:** several suites create a real private repo and a project row
  and never tear either down. The S28 parity suite is the clearest case - it
  printed the repository URL and exited. Every run left a project, its
  credentials, and review Issues in your queue asking you to read a report about
  a repository you have never seen.
- **Fixed going forward:** a passing run now cleans up after itself
  (`scripts/lib/fixture.ts`). A FAILED run is left standing on purpose, because
  the rows are the evidence, and `KEEP=1` does the same for a passing one.
- **What I need you to say:** whether to delete what has already accumulated.
  120 project rows exist and 21 of them are fixtures (`s6-`, `s7-`, `s22-`,
  `s28-`, `l6-`, `n1-` and friends), plus 6 private GitHub repositories on your
  account. I have not deleted any of them: dropping rows and repositories is
  irreversible and is your call, not mine.
- **Already done, because it is reversible:** the three `[review]` tickets those
  fixtures left in your queue are resolved with the reason recorded. Your queue
  is down from 7 to 2.
- **Raised:** 2026-09-02 23:30

## May a confidential project use telnyx, elevenlabs and composio?

- **Step:** S37 / isolation
- **Decided already:** models. A confidential project may use every paid model
  (anthropic_personal, cursor_personal, openai_codex_personal, fireworks) and no
  free tier (groq, nvidia, google_ai). That is live and asserted.
- **Not decided:** the three SERVICE connections. They are not models, so your
  answer did not cover them, and I am not extending it by inference - each one
  carries a confidential project's content just as a model does:
  - **telnyx** - the words of a call. Speech in, speech out, over a carrier.
  - **elevenlabs** - whatever Jarvis says aloud is sent there to be rendered.
  - **composio** - whatever a tool call passes through it.
- **What happens today:** all three are `{normal}`, so a confidential project
  cannot use them at all. That means a confidential project currently cannot be
  discussed by voice. That may well be what you want; it should be a decision.
- **Not asked:** `restricted` was not part of your decision either, so nothing
  is eligible for it. Deliberate, and easy to widen once you say so.
- **Moot:** github_personal_admin, backup_b2 and netcup_scp are broker-only.
- **Raised:** 2026-09-02 22:40

## The WhatsApp QR is ready for you to scan

- **Step:** S37 item 3
- **What I need you to do:** run this yourself, in your own terminal, and scan
  the QR with WhatsApp on your phone (Settings > Linked devices > Link a device):

      ssh jarvis-netcup
      sudo docker exec -it jarvis-openclaw-1 openclaw channels login --channel whatsapp

  It has to be your terminal because the QR refreshes every few seconds - one I
  generated here would expire long before you saw it. I am deliberately not
  pairing on your behalf.
- **What is ready:** the channel is installed, enabled and configured
  (`WhatsApp default (Enrique): installed, enabled, not linked`). I verified the
  login command renders a live QR, then let it expire without scanning.
- **What I had to change to get there:** the WhatsApp plugin requires OpenClaw
  plugin API >= 2026.8.2 and the runtime was 2026.8.1, so I upgraded OpenClaw
  and re-verified the bridge afterwards - it registers both hooks, and the send
  route still authenticates, validates and reaches the CLI.
- **Two things I set before handing you the QR:**
  - `session.dmScope` is now `per-account-channel-peer`. It was unset, and the
    default is `main` - one shared session for every DM, which is exactly the
    memory role OpenClaw is not supposed to have.
  - OpenClaw still has no usable model credential (`openai/gpt-5.6-sol`,
    `Auth: no`), so it cannot compose a reply even if a hook failed open.
    Adding any credential silently removes that guarantee.
- **What I could not prove without you:** that `before_agent_run` actually
  blocks on the WhatsApp inbound path. It needs a real inbound message. The
  hook is registered on every gateway start (logged), but registered is not
  fired, and I will not claim it until a message arrives and OpenClaw stays
  silent. Send me any message after pairing and I will check.
- **Raised:** 2026-09-02 22:20
- **Since then:** the channel being *configured but not linked* changed the
  failure text from `Channel is unavailable: whatsapp` to `OutboundDeliveryError:
  No active WhatsApp Web listener`, which the deferral did not recognise - nine
  queued notifications burned their whole retry budget in one sweep before I
  caught it. Both strings now defer, the decision is a named function with the
  real strings under test, and all 19 are back at `attempts = 0`.
- **Voice notes are ready too:** audio is stored as a `raw_audio` artifact on the
  same 7-day clock as call audio, transcribed with Groq Whisper, and the
  transcript is routed exactly like typed text - including the untrusted rule, so
  a FORWARDED voice note is filed as somebody else's words and obeys nothing.
  Proven live by posting payloads at `/internal/inbox/ingest`. What the bridge
  cannot know until you pair is which field carries the audio; it handles the
  three the plugin uses and logs the shape of the first real one.

## WhatsApp is not paired, and 19 notifications are waiting on it

- **Step:** S37 item 4
- **Blocked on:** Scanning a QR code with your phone. Only you can do that.
- **What is ready:** The whole path, proven as far as it can be proven without a
  phone. The bridge exposes an HMAC-authenticated send route inside OpenClaw,
  the worker calls it, and 19 queued notifications sit at `attempts = 0` with
  `channel not paired yet; deferred without spending an attempt`.
- **Why they are deferred rather than retried:** Wiring a real transport turned
  a channel that never sent anything into one that tries and is refused. Left
  alone, the retry curve would have spent all seven attempts before you scanned
  anything, marked the queue `failed`, revived it, and looped. Deferring keeps
  all 19 intact so that on pairing each arrives exactly once - not zero.
- **What I need you to do:** Nothing yet. The channel is not configured in
  OpenClaw at all (`openclaw channels list` reports none), so there is no QR to
  scan yet. I am doing that next; you will get the QR when there is one.
- **What I could not test:** Delivery itself. Even `--dry-run` needs a live
  channel, so the live path ends at `Channel is unavailable: whatsapp`. That
  the 19 arrive exactly once can only be observed after you pair.
- **Raised:** 2026-09-02 22:05

## Postgres password was not URL-safe

- **Step:** S4
- **Blocked on:** Nothing of yours in the end — recorded because it looked like a
  permissions problem and was not.
- **What I need you to do:** Nothing.
- **What I tried:** Wrote `DATABASE_URL` into `/etc/jarvis/runner.env` with the
  raw password from `compose.env`. `pg` rejected it with `ERR_INVALID_URL`; the
  44-character password contains characters that must be percent-encoded.
- **What I did instead:** Percent-encoded the password when writing the file.
  `src/db.ts` already does this when building a URL from `POSTGRES_PASSWORD`;
  only the hand-written `runner.env` path was missing it.
- **Raised:** 2026-09-02 00:05
- **Resolved:** 2026-09-02 00:06 — same tick.

## GitHub PAT cannot create repositories

- **Step:** S5 (and L6, its acceptance gate)
- **Blocked on:** `github_personal_admin` is a **fine-grained** PAT without the
  `Administration: write` permission. `POST /user/repos` returns
  `403 Resource not accessible by personal access token`. It also only sees two
  repositories — `personal-portfolio` and `ticket-lock` — both of which are your
  own and off limits to me, and it cannot see `jarvis-core` at all.
- **What I need you to do:** At <https://github.com/settings/personal-access-tokens>,
  either edit the existing Jarvis token or issue a new one with:
  - **Repository access:** All repositories (or at minimum, permission to create
    new ones under `enriquealonso01`)
  - **Account permissions → Administration:** Read and write  *(creates repos)*
  - **Repository permissions → Administration:** Read and write  *(registers deploy keys)*
  - **Repository permissions → Contents:** Read and write  *(push branches)*
  - **Repository permissions → Pull requests:** Read and write  *(S7 opens PRs)*

  Then paste it into the Control Center → Connections → `github_personal_admin`,
  or tell me and I will store it via the broker.
- **What I tried:** `GET /user` returns 200 as `enriquealonso01`, so the token is
  valid and readable — only the write permissions are missing. Verified the exact
  403 body rather than guessing from the status code.
- **What I did instead:** Proved S5's deploy-key isolation against a local SSH
  git server in the dev stack — two users, two repos, two keys, and project A's
  key failing against project B's repo. That tests Jarvis's key handling, which
  is the part S5 owns. It does NOT test GitHub, so **S5 stays PARTIAL** and L6
  is not claimed until the token can create the two private repos.
- **Also blocks:** S8's N1.5 — the acceptance case is written and 4 of its 5
  assertions pass (the seeded test really goes red -> green on Jarvis's branch);
  only "a pull request was opened for it" is red, and it is red because of this.
- **Also blocks:** S7's first test ("a real PR on a real private repo"). The
  pull-request code is written and its three refusal paths are tested (21/21);
  only the live PR is missing. One run finishes it once the token works.
- **Raised:** 2026-09-02 00:33   **Resolved:** 2026-09-02 02:55 — Enrique widened
  the existing fine-grained token in place (All repositories; Administration,
  Contents and Pull requests all read/write). Same token string, so the stored
  credential and its fingerprint were unchanged and nothing was re-entered.
  Verified through the broker before relying on it: `GET /user` 200 as
  enriquealonso01, `GET /repos/enriquealonso01/jarvis-core` 200 with
  `permissions.admin: true`. `POST /user/repos` proved by L6 creating two real
  private repos. S5 21/21, S7 13/13, S8's N1.5 green.

## Intermittent: burst of three messages sometimes yields two tasks

- **Step:** S2 (regression surface for S3's routing)
- **Blocked on:** Nothing of yours — recorded here so it is not lost. It is a
  real defect against the plan's "three messages in ten seconds -> three tasks,
  none merged, none dropped".
- **What I need you to do:** Nothing. Mine to chase.
- **What I tried:** Twelve runs after the failure, all clean; roughly 1 in 10.
  Not reproducible on demand yet.
- **What I did instead:** Added diagnostics to the test so the next occurrence
  dumps the tasks and the inbox events with their route verdicts. Continued to
  S9.
- **Raised:** 2026-09-02 02:10   **Resolved:** 2026-09-02 02:35 — not a flake. The
  Supervisor appended the message it was answering only when the history did not
  already contain it, and the history always does; under concurrency a turn could
  end on a sibling's message. Fixed by filtering it out of history and appending
  it explicitly. 65 burst rounds clean; the old guard reproduces it on round 1.


## Per-project unix users — the wall behind the file tripwire

- **Step:** S12
- **Blocked on:** A decision about how the runner drops privilege, which changes
  the isolation model and so is yours, not mine.
- **What I need you to do:** Pick one of these, or name a third:
  1. **The runner starts as root and drops to the project's uid per task.**
     `jarvis-runner.service` runs as `User=root` with `NoNewPrivileges=no`, and
     the harness is spawned with `setuid`/`setgid` to the project's own uid.
     Strongest isolation; also means a root process on the box.
  2. **A small setuid helper.** The runner stays as `jarvis` and execs a
     single-purpose binary that only knows how to `setuid` to a
     `jarvis-p-<slug>` user and exec the harness. Smaller blast radius, more
     moving parts, and a setuid binary of my own writing is itself a risk.
  3. **One container per project**, uid mapped per project, harness inside it.
     Fits the Docker-by-default rule in ADR 006 but contradicts ADR 015, which
     put the heavy runner on the host precisely to avoid this.
  Whichever you pick, say whether it applies to **every** project or only to
  professional/confidential ones — ADR 006 step 5 says "professional or
  confidential projects" get a dedicated uid at project create, and personal
  projects sharing the `jarvis` user is a deliberate choice in that ADR, not an
  oversight.
- **What I tried:** Proved what exists rather than assuming it. A task in Alpha
  reads Beta's `repo/.env` and Beta's browser profile: the runner sees the path
  in the harness's Bash command, kills the run, discards the branch, audits the
  attempted path and raises an Issue — every time, and the test goes red when the
  guard is removed. But the read itself succeeds at the filesystem layer, because
  the runner and every project's files are the same unix user. Detection works;
  containment does not exist.
- **What I did instead:** Closed the part that was mine. The command scanner
  guarded `projects/`, `keys/` and `harness-auth/` and NOT `browsers/` or other
  tasks' `worktrees/`, so a `cat` of another project's cookie jar walked past the
  tripwire undetected. Both are now guarded, with the probe that proves it. S12's
  own Done-when (L8, L9, L11) passes at 47/47; the step is marked **partial**,
  not done, because ADR 006 step 5 is the wall it was named as the proof point
  for and that wall is not built.
- **Raised:** 2026-09-02 03:40
- **Resolved:** 2026-09-02 — option 2, with sudo + setpriv rather than a setuid
  binary of my own writing. The runner stays `User=jarvis`; a sudoers rule
  permits only `setpriv --reuid/--regid --clear-groups -- <harness>` against
  `jarvis-p-*` users and can never name root; `NoNewPrivileges` comes off
  `jarvis-runner.service` as the accepted cost. Scope is professional and
  confidential projects only — personal ones keep sharing `jarvis` per ADR 006
  step 5. Written up as ADR 016 and verified the way he asked: the cross-project
  read now fails `Permission denied` in the kernel, not at the tripwire
  (`scripts/s12-privdrop-test.sh`, 28/28, with the negative control showing the
  read succeeding again when `--clear-groups` is dropped).

## No Telnyx `connection_id`, so Jarvis has never actually dialled out

- **Step:** S23
- **Blocked on:** `telnyx.connection_id` is not pinned in `site.yaml`. Outbound
  calls go through `POST /v2/calls`, which requires the Call Control application
  id; without it the sweep refuses to dial and says so.
- **What I need you to do:** Paste the Call Control application id from the
  Telnyx portal (Voice → Call Control Applications → the one the inbound number
  points at) into `site.yaml` as `telnyx.connection_id`. Inbound already works,
  so the application exists — it is only its id that Jarvis does not know.
- **What I tried:** Everything that does not need it. S23 is built and merged
  (PR #123): the six reasons and no others, quiet hours with the narrow security
  override, the WhatsApp fallback when a call cannot be placed, and 54/54 in the
  fake. Two genuinely blocked tasks are sitting in the queue right now with the
  sweep reporting `no telnyx connection_id pinned in site.yaml` against them —
  which is the correct behaviour and also the proof that the decision half works.
- **What I did instead:** Marked S23 `blocked`, not `done`. Its Done-when is "a
  genuinely blocked task rings the phone during the day and stays silent at
  21:00", and a phone that has never rung has not been observed ringing.
- **Raised:** 2026-09-02 18:05
- **Resolved:** 2026-09-02 16:30Z — `telnyx.connection_id = 3039460355509061310`
  (the "JARVIS" call-control application, the same connection inbound arrives
  through) is pinned in `/etc/jarvis/site.yaml` on the box. A backup of the old
  file is beside it as `site.yaml.bak-*`. **S23 is still not done** — the first
  real dial after pinning it found a second defect; see the next entry.

## Jarvis can reach the phone, but the phone will not ring for it

- **Step:** S23
- **Blocked on:** A setting on your handset. Nothing in the repo can do it.
- **What I need you to do:** Save `+13057866217` as a contact. If **Silence
  Unknown Callers** is on (Settings → Apps → Phone), an unknown number is
  delivered silently and sent to voicemail, which is exactly what we saw.
- **What happened:** the dial defect below is fixed and deployed, and the
  production sweep placed a real call: Telnyx 200, a real `call_control_id`,
  `outbound: blocked_task: retried at 08:00 — ringing`. You received it and it
  did not ring. The webhook trail agrees with the handset explanation and not
  with a Jarvis fault — we got **only** `call.hangup` for that leg, never
  `call.initiated`, `call.ringing` or `call.answered`, and it arrived ~31s after
  the dial, matching the 30-second `timeout_secs`. That is a delivered call that
  was never picked up.
- **Why this is not just cosmetic:** S23 exists so that a blocked task can
  interrupt you. A pager that is delivered silently is not a pager, and every
  one of the six reasons inherits the problem.
- **What I did instead:** left S23 `blocked` and moved on. Its Done-when is "a
  genuinely blocked task rings the phone during the day and stays silent at
  21:00" — the placing half is now observed in production, the ringing half is
  yours, and the 21:00 half is so far only proved in the fake (54 of the 61
  assertions, including that the only thing that rings at 20:00 is a security
  event).
- **Raised:** 2026-09-02 17:15Z
- **Resolved:** 2026-09-02 18:21Z — Enrique saved the number and turned on
  Emergency Bypass, and the next call rang. One call placed (not two — through
  `placeCall` directly rather than the sweep, which walks every reason and
  dialled twice last time). The trail, from `call_transitions`:
  `call.answered` at 18:21:22 entering from state **`ringing`**, greeting
  played, `call.playback.ended`, `call.transcription` at 18:21:38 — he said
  "This is just a test. Thank you." — Jarvis answered (ack 899ms, model 822ms,
  total 2793ms), then `call.hangup` at 18:21:46. One row in `calls`, and the
  `security_event` row stayed `failed` and untouched.
  **S23 is still not done: two of its three halves are observed.** Placing and
  ringing are real; "stays silent at 21:00" is so far only proved in the fake.
  See the next entry.

## S23's third half: nothing has been observed staying silent

- **Step:** S23
- **Blocked on:** A decision from you, or one call attempt after 19:30.
- **The Done-when is a conjunction:** "a genuinely blocked task rings the phone
  during the day **and** stays silent at 21:00." The first half is now observed
  in the world. The second is proved only in the fake — 54 of the 61 assertions,
  including the one that matters most, that the *only* thing which rings at 20:00
  is a security event, and that a blocked task at 20:00 becomes a WhatsApp plus
  an Issue plus an 08:00 retry.
- **Two ways to close it, both yours:**
  1. After 19:30, tell me and I will put a blocked task on the retry path. The
     phone should stay silent, a WhatsApp should arrive instead, and an Issue
     should open with a retry time. That is the Done-when observed.
  2. Say the fake's proof is enough for the quiet-hours half, and I will mark
     S23 done recording exactly which half was observed where.
- **Why I am not choosing:** the whole reason S23 sat blocked for a day was that
  a phone which had never rung had not been observed ringing. The same sentence
  applies to a phone that has never been observed staying quiet, and I would
  rather ask once than quietly weaken the standard I was held to yesterday.
- **Raised:** 2026-09-02 18:35Z

## IN FLIGHT — S23 outbound dial sends a blank `from`

- **Step:** S23
- **Blocked on:** Nothing of Enrique's. This is unfinished work, recorded here so
  it is not lost.
- **State:** `telnyx.connection_id` is pinned and read correctly — the refusal is
  no longer "no connection_id pinned". A real `POST /v2/calls` now returns
  `422 10004 Missing required parameter /from`.
- **Cause, already found:** `placeCall` in `src/outbound.ts` (~line 183) reads
  `whatsapp.owner_e164` and `whatsapp.jarvis_e164` for a **voice** call. The
  phone pair is `telnyx.from_e164` (`+13057866217`) and `telnyx.to_e164`
  (`+13055052646`); `whatsapp.jarvis_e164` is blank, so `from` went out empty.
  Both are in `SiteConfig` already (`src/siteconfig.ts`).
- **The fix:** read the telnyx pair for the dial, falling back to the WhatsApp
  owner number for `to` only. Then place a real call and observe the phone ring.
  No fake-mode test can catch this: `placeCall` returns before `telnyxDial` when
  `JARVIS_TELNYX=fake`, so the live call IS the test.
- **Two traps on the retry** (also in DEBUG_NOTES): `placeCall` refuses when
  `attempts > 0`, and `reasonsToCall` skips any task that already has an
  `outbound_calls` row. Reset the row first:
  `UPDATE outbound_calls SET state='wanted', blocked_reason=NULL, attempts=0 WHERE id = ...`
- **Current rows:** two `blocked_task` calls for the two `waiting_for_user`
  tasks, both `state='failed'`, `attempts=1`. Placing both back to back would
  ring Enrique twice in a minute, which the pager rule (§17) is against — place
  one, confirm, then decide about the second.
- **Raised:** 2026-09-02 16:50Z
- **Resolved:** 2026-09-02 17:05Z — PR #132. The dial reads `telnyx.from_e164`
  and `telnyx.to_e164`, with the WhatsApp owner kept as a fallback for the
  destination only and none at all for the sender; an unpinned sender is refused
  by name instead of sent blank. Contrary to the note above, the fake CAN see
  this once the recorded dial carries `from` and the fixture stops giving every
  number the same value — 61 assertions, 7 of them seen red against the old two
  lines, printing the WhatsApp pair as the actual. Deployed, and one real call
  placed on row `aefc6805` via the retry path. Two things this uncovered have
  their own entries: the sweep never looks at a `wanted` row, so the reset
  above does nothing; and the call reached the handset but did not ring.

## Publishing `PROGRESS.json` is a habit, not a mechanism

- **Step:** S13b (the build bar), surfaced 2026-09-02
- **Blocked on:** Nothing of Enrique's — this is a design choice inside the
  console deploy, and it is mine to make. Recorded because it is not done.
- **What is wrong:** the bar fetches `/PROGRESS.json`, served from
  `/opt/jarvis/control-center/PROGRESS.json` — a copy published by
  `scripts/progress-publish.sh`, which is run by hand. It was published once at
  00:41 and went 21 hours stale, reporting S5 / 37 steps against a repo on
  S25 / 40. `deploy-control-center.sh` rsyncs `--delete`, so a console deploy
  also removes the copy unless it is re-published afterwards.
- **What Enrique asked for:** fix it structurally — one source, or publish on
  every state change — and verify by advancing a step and watching the live URL
  move with nobody running a script.
- **Interim:** run `scripts/progress-publish.sh` after every
  `progress-sync.mjs` **and** after every console deploy.
- **Raised:** 2026-09-02 16:55Z
- **Resolved:** 2026-09-02 17:11Z — structurally, as asked. `/PROGRESS.json` is
  routed by Caddy to the API, which serves it from
  `/opt/jarvis/core/PROGRESS.json`: the deployed source tree, which is also the
  images' build context and what the host runner executes. One file on the box,
  updated by the same action that ships code, and out of reach of the console
  deploy's `rsync --delete`. The mount is the directory rather than the file,
  because a deploy replaces the inode. `progress-publish.sh` is kept as a
  signpost that explains why it now does nothing. Verified live: the URL
  returned `S26 / 40 steps` with nobody running a script, alongside the
  `charset=utf-8` and `Last-Modified` it had never sent before.
- **Reopened and resolved again:** 2026-09-03 07:50Z. The resolution above did
  not hold, and the way it failed is worth keeping. Serving from
  `/opt/jarvis/core/PROGRESS.json` ties the bar to the deploy tree, and every
  code deploy extracts a tarball over that tree - so a deploy cut from a feature
  branch silently republished that branch version of the truth. The file moved
  to `/var/lib/jarvis/state`, out of the deploy path, and publishing became
  `scripts/publish-progress.sh` run by hand. That is where the staleness came
  back: found three hours old today, for the same reason as the original 21
  hours. A script that runs on the workstation and pushes over scp cannot be
  structural - the workstation is not always on, and nothing on the box knows it
  is behind. Now the box pulls: `scripts/publish-progress-pull.ts` reads both
  files from the repository with the admin token it already holds, on
  `jarvis-progress-publish.timer`, every five minutes. Verified exactly as
  Enrique asked: a marker string was committed to `main` and appeared at the
  live URL with nobody running anything. Also covered by
  `tests/s13b-publish-live.sh` (6 assertions), including that a publish which
  fails to parse keeps the previous good file - sabotaging that order leaves the
  console being served markdown.

## Deployed files are owned by a Windows uid that does not exist on the box

- **Step:** operational, surfaced by Enrique 2026-09-02
- **Blocked on:** Nothing. Recorded so it is fixed before it bites.
- **What is wrong:** `/opt/jarvis` and `/opt/jarvis/core` hold files owned by
  `197609:197609` — the uid `tar` preserved from the Windows side. Harmless at
  0644, and it will bite the moment permissions tighten the way ADR 016 tightened
  them. Related: `dist/` had 28 root-owned files that made `pnpm build` as
  `jarvis` half-fail for days (DEBUG_NOTES).
- **The fix:** `tar --no-same-owner` on extraction, or `chown -R` after, and a
  one-off `chown` of the two trees.
- **Raised:** 2026-09-02 17:00Z

## Every auth profile is eligible for `normal` only, so a confidential project can use nothing

- **Step:** S26 (surfaced), S12/§80.1 (the mechanism)
- **Blocked on:** A decision about which accounts may see confidential work.
  That is a trust boundary, so it is yours.
- **What I found:** `auth_profiles.confidentiality_eligibility` exists, is
  enforced by `checkProfileAccess`, and every one of the 13 rows on the box is
  seeded `{normal}`. `anthropic_personal`, `openai_codex_personal` and
  `cursor_personal` included. So a project with `confidentiality = confidential`
  is refused **every** credential in the system — correctly, fail-closed, and
  uselessly: it can be created and can then do nothing at all.
- **What I need you to do:** say which profiles may serve `confidential` work,
  and which may serve `restricted`. My reading is that the three subscription
  logins qualify for `confidential` (you pay for them, and a subscription is not
  a training-data tier) and that nothing currently qualifies for `restricted`,
  but I am not widening an isolation rule on my own reading. Give me the list and
  it is one UPDATE.
- **What I did instead:** built the half that narrows rather than widens.
  Onboarding now refuses to give a professional project a free consumer account,
  deriving the tier from what is recorded (`subscription_login` = subscription,
  `metered_spend_allowed` = billed, an API key with neither = free tier) rather
  than from a list of provider names. The broker refuses the same thing again at
  use. 52/52, six seen red.
- **Raised:** 2026-09-02 17:55Z

## S26's Done-when needs you to talk to Jarvis

- **Step:** S26
- **Blocked on:** One phone call. Only you can make it.
- **The Done-when:** "a project created by **voice** ends with a correct
  committed `AGENTS.md`."
- **Where it stands:** everything up to the voice is done and proved. Onboarding
  renders the file or refuses and names what is missing; the canonical row is
  written; the file is committed into a real private repository, and the live
  test asserts the committed bytes equal the canonical row exactly (11/11 against
  `enriquealonso01/jarvis-s26-fixture`). The live test drives the same dispatcher
  a model turn drives, on a conversation whose channel is `voice` — but nothing
  has yet been said out loud to create a project.
- **What I need you to do:** call Jarvis and create a project by talking to it.
  Give it a name, a slug, and answer the questions it asks. It should end with a
  repository containing an `AGENTS.md` that says what you said.
- **Why I am not claiming it without that:** the same reason S23 is not done. A
  test that drives the tool layer proves the tool layer. The step says voice, and
  the interesting failures — a slug misheard, a question skipped because the
  model decided it knew, an answer recorded that you did not give — all live
  above the layer the test touches.
- **Raised:** 2026-09-02 17:55Z

## S27's Done-when needs a spoken sentence too

- **Step:** S27
- **Blocked on:** You saying something to Jarvis. Same shape as S26's blocker.
- **The Done-when:** "a sentence changes a different project's behaviour, is
  auditable a week later, and can be rolled back."
- **Where it stands:** all three are built and proved through the dispatcher a
  model turn drives — 85 assertions. A change lands on the project he NAMED
  while the conversation is scoped to another one; the immutable list refuses and
  raises an approval; an ambiguous instruction returns one question and writes
  nothing at all; rollback restores a previous value exactly by writing a new
  version, so history is never rewritten. There is exactly one writer, asserted
  by reading `src/`.
- **What I need you to do:** tell Jarvis to change something about a project you
  are not talking about — "from now on nobody deploys Alpha without asking me" —
  and then, later, ask it what changed and to put it back.
- **The honest gap besides the voice:** "auditable a week later" is proved by
  backdating a row and asking for the last seven days. That tests the query, not
  the passage of time. Only time tests the passage of time; the first real
  question you ask a week from now is the real assertion.
- **Raised:** 2026-09-02 18:40Z

## IN FLIGHT — the bridge plugin targets an OpenClaw API that does not exist

- **Step:** S37 item 3
- **Blocked on:** Nothing of Enrique's. Recorded because it changes the shape of
  the step and must not be forgotten.
- **What is true now:** OpenClaw is configured and healthy for the first time
  (`gateway.mode=local`, a gateway token in `/etc/jarvis/compose.env`, 13 stock
  plugins, `[gateway] ready`). `channel_allowlist` has the commanding identity
  and the outbox revived 18 notifications.
- **What is wrong:** `packages/openclaw-jarvis-bridge/index.js` exports
  `{ onInbound }` and returns `{ skipDefaultAgent: true }`. **Neither exists in
  OpenClaw 2026.8.1.** The real hook surface is `onAgentRunStart`, `onSend`,
  `onDeliveryStatus`, `onStartup` and friends, and the mechanism for taking a
  conversation away from the default agent is called a **runtime takeover**
  (`docs.openclaw.ai/plugins/sdk-channel-inbound`, "Building channel plugins").
  The bridge was written against an assumed API and has never once been loaded,
  so nothing ever contradicted it.
- **How it surfaced:** `openclaw plugins install` refused it — first for a
  missing `openclaw.extensions` key, then for a missing `openclaw.plugin.json`
  manifest. Fixing those two would have made it *install*, and its hook would
  simply never have fired: an inbound DM would have gone to OpenClaw's own
  agent, which is precisely what the bridge exists to prevent.
- **Why the plugin is NOT being installed yet:** a plugin that loads and does
  nothing is worse than one that refuses to load. The refusal is currently the
  only thing telling the truth.
- **The real contract, read out of the docs rather than assumed:**
  - `message_received` — the inbound hook. This is where Jarvis is told, and it
    must persist BEFORE anything else happens (ADR 001/002).
  - `before_agent_run` → `{ outcome: "block", reason, message? }` — the
    documented way to stop OpenClaw's own agent. This is the real
    `skipDefaultAgent`.
  - `before_agent_reply` for a synthetic reply; `reply_dispatch` is the advanced
    takeover seam. Neither is needed if the run is simply blocked.
  - Caveat from the same page: `before_agent_run` is implemented by the embedded
    and CLI runners and is NOT a gate on Codex or Copilot runtimes. WhatsApp DMs
    go through the embedded runner, so it applies here — but that is a fact to
    re-check, not a general guarantee.
- **Config cannot do this instead.** `channels.<x>.dm.autoReply` exists for some
  channels; the WhatsApp block has `dmPolicy`, `allowFrom`, `dmHistoryLimit` and
  `dms`, and no `autoReply`. So silencing the default agent on WhatsApp needs the
  hook — checked before writing code rather than after.
- **Where it got to, 20:40Z.** The bridge is rewritten and LOADS:
  `14 plugins: … jarvis-bridge …`, no register errors, and
  `plugins.entries.jarvis-bridge.hooks.allowConversationAccess=true` cleared the
  one thing `plugins doctor` complained about. Four wrong shapes were tried and
  each was caught by OpenClaw rather than by me — `onInbound`/`skipDefaultAgent`
  (does not exist), a bare default export and a `register` export (both called
  with `undefined`), and `api.registerHook` for a typed hook, which the loader
  warns is "not invoked".
- **What is NOT proven, and it is the only thing that matters:** that
  `before_agent_run` actually blocks. `openclaw agent -m "say OK"` ran through
  the gateway and reached OpenAI (401, no credential) — it was not blocked. Two
  readings and I cannot yet separate them:
  1. that path does not dispatch `before_agent_run` at all. The docs say it is
     implemented by "the embedded and CLI runners", and this went through the
     gateway; or
  2. the hook is still not registered. `openclaw hooks list` shows five bundled
     hooks and none of ours — though that command manages "internal agent
     hooks", which may be a different subsystem from plugin typed hooks.
- **Why this is not a QR yet.** The only path that matters is an inbound
  WhatsApp DM, and testing it needs pairing — while pairing before the block is
  proven means Enrique's DMs get answered by OpenClaw's own agent, with its own
  model and memory. That is the deadlock, stated plainly rather than resolved by
  optimism.
- **Settled 20:50Z, by instrumenting the hook rather than reasoning about it.**
  The bridge logs on registration and on every fire. On restart the gateway logs
  `[jarvis-bridge] registering message_received and before_agent_run` — so the
  plugin IS registered and `api.on` is the right API. An `openclaw agent -m` turn
  then reached OpenAI without a single "fired" line: **registered, but not
  dispatched on that path.** That matches the documented caveat that
  `before_agent_run` is implemented by "the embedded and CLI runners". Whether it
  is dispatched on the WhatsApp INBOUND path is still unknown and still needs a
  real message.
- **What makes pairing safe anyway — checked, not assumed.** `openclaw models
  list` reports exactly one model, `openai/gpt-5.6-sol`, `Auth: no`, `Local: no`.
  OpenClaw has no usable model credential and cannot generate a reply at all;
  that is why the agent turn 401'd rather than answering. So the risk that
  pairing lets OpenClaw answer Enrique's DMs with its own agent is not merely
  mitigated by the hook — it is currently impossible for a second, independent
  reason. **That property must be re-checked before relying on it again**, since
  adding any provider credential to OpenClaw would silently remove it.
- **Therefore the order stands, but for a better reason:** pair only after the
  outbox is wired (item 4), so the 19 queued notifications deliver exactly once
  — not because pairing is dangerous, but because pairing is the moment they go
  out.
- **Item 4's send path, 20:55Z.** The worker cannot run the OpenClaw CLI (wrong
  container) so it needs an HTTP route. What was ruled out and why:
  - `POST /api/v1/admin/rpc` (the stock `admin-http-rpc` plugin) IS reachable
    from the api container with the gateway token — `health` returns ok. But its
    method list is `health`, `status`, `agents.create|delete|list|update`. There
    is no send. It was enabled to find that out and has been **disabled again**:
    it is a full operator surface, it is not needed, and leaving a speculative
    widening of the attack surface in production because it was convenient to
    test with is exactly the kind of thing nobody remembers to undo.
  - The gateway's own protocol is WebSocket; a WS client in the worker is
    possible but is the most code for the least support.
  - **The chosen path:** the bridge already runs inside OpenClaw, and the plugin
    api includes `registerHttpRoute`. The bridge exposes one internal send
    endpoint, the worker POSTs to it, and the plugin performs the send with
    OpenClaw's own helpers. It makes the bridge bidirectional, which it needs to
    be anyway, and keeps the outbox's state machine untouched — the only change
    in `worker.ts` is replacing the "transport not paired" stub with a call.
- **Raised:** 2026-09-02 20:40Z

## Ordering question for Enrique: S37 (WhatsApp) versus S25–S36

- **Step:** S37
- **Blocked on:** A decision only Enrique makes. Not urgent; the build continues
  in order unless he says otherwise.
- **The question:** the WhatsApp number is registered and pairs by QR, and he
  reported openclaw was never configured (`exit 78`, missing gateway config,
  empty state dir; container stopped, not looping). The untrusted-content rule
  has **no implementation anywhere** — no flag, no `is_forward`, nothing in
  `src/` or the migrations — and S37 calls that the injection vector for the
  whole system. It is recorded as S37's first build item, before any pairing.
  If he wants WhatsApp sooner, S37 moves ahead of S26–S36; otherwise it waits.
- **Raised:** 2026-09-02 17:05Z

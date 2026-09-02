# Blocked

Things only Enrique can do. One entry per blocker. Entries are never deleted —
resolved ones stay as a record of what fixed them.

Re-read this file at the start of every tick. If something here is now
unblocked, finish it before starting anything new.

---

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
- **Raised:** 2026-09-02 03:40   **Resolved:**

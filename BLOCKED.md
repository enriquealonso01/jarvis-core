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
- **Raised:** 2026-09-02 00:33   Resolved:


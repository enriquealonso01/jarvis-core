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

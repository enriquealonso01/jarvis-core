# Deploying the heavy-lane runner (plan S4)

The runner is the only Jarvis component that is **not** a container. It runs on
the host under systemd as the unprivileged `jarvis` user, because the Claude Code
subscription login is host-user filesystem state bound to a config directory
(ADR 006, ADR 015).

Everything below touches production permissions on the Netcup box, so it is
Enrique's to run or to authorise.

## What is already true on the box (surveyed 2026-09-01)

| | |
|---|---|
| `jarvis` user | exists, uid 1000, gid 988 |
| `/usr/bin/node` | v22.23.2 — matches the unit's `ExecStart` |
| `/usr/bin/claude` | 2.1.252, runs as `jarvis`. The symlink target is named `claude.exe`; it is a Linux binary with a misleading name, not a problem |
| Host login | **complete** — `.credentials.json` exists and is `jarvis`-owned; `auth_profiles.anthropic_personal` is `healthy` with the right `harness_auth_dir` |
| Postgres | listening on `127.0.0.1:5432`, container healthy |
| `/etc/jarvis` | exists, `0750 root:jarvis` |

## The box is running pre-S1 code — sync it FIRST

Surveyed 2026-09-01. `/opt/jarvis/core` does not contain `paths.ts`,
`routing.ts`, `work.ts` or `fakemodel.ts`; its `migrations/` stops at `009`, and
the live database has 9 migrations applied. It is a **file drop used as a Docker
build context**, not a git checkout, so it does not move when `main` does.

This matters more than it looks: running `pnpm build` there today would build
the *old* runner — the one with the blank-summary bug, no `JARVIS_ROOT`, and no
mid-run context delivery. The unit would come up and run the wrong code.

So the order is:

1. **Merge the stack** — S1 (#7), S2+S3 (#9), S4 (#16) — to `main`.
2. **Sync `/opt/jarvis/core` from `main`.** Sync the *contents* in place rather
   than replacing the directory: Compose builds from that path and the
   Control Center deploy script already documents why swapping the inode
   underneath a running container breaks it.
3. **Apply migrations 010 and 011** (route decisions, task context). The API and
   worker containers rebuild from the same path, so they need the new schema
   before they restart.
4. Only then the three fixes below, then the unit.

I have not done step 2 because I do not know which transfer mechanism this box
expects, and guessing at a production deploy path is exactly the wrong place to
improvise.

## Three things block the deploy

### 1. `.claude.json` is owned by root inside the jarvis config dir

```
root 600 /var/lib/jarvis/harness-auth/anthropic_personal/.claude.json
root 644 /var/lib/jarvis/harness-auth/anthropic_personal/.last-cleanup
```

Verified: as `jarvis`, that file is `PERMISSION_DENIED` to read and `NOT_WRITABLE`.
Claude Code rewrites `.claude.json` on every run, so the runner would fail on its
first real task — this is exactly the plan's own debug note, *"permission errors
on `CLAUDE_CONFIG_DIR` mean the login ran as the wrong user"*. Part of the login
ran as root.

```bash
sudo chown -R jarvis:jarvis /var/lib/jarvis/harness-auth/anthropic_personal
```

### 2. There is no built code at `/opt/jarvis/core/dist`

`/opt/jarvis/core` holds `src/`, `migrations/`, `package.json` and is used only
as a Docker build context — it is not a git checkout and has no `dist/`. The
unit's `ExecStart=/usr/bin/node /opt/jarvis/core/dist/runner.js` has nothing to
run.

```bash
# ONLY after the sync above — otherwise this builds pre-S1 code.
cd /opt/jarvis/core
sudo -u jarvis pnpm install --frozen-lockfile
sudo -u jarvis pnpm build          # produces dist/runner.js
```

### 3. `/etc/jarvis/runner.env` does not exist

See `deploy/runner.env.example`. It carries `DATABASE_URL` and nothing else.

## Then install the unit

```bash
sudo install -m 0644 /opt/jarvis/core/deploy/jarvis-runner.service \
  /etc/systemd/system/jarvis-runner.service
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-runner
```

## Verify — the plan's own Test section

```bash
# the ceiling is applied, not merely written in the file
systemctl show jarvis-runner -p MemoryMax -p MemoryHigh
# expect MemoryMax=4294967296

# one real heavy task, end to end
journalctl -u jarvis-runner -f
```

Then, from the console, create a heavy task against a project with a checkout
and confirm: it reaches `succeeded`, the transcript artifact is visible, and

```bash
sudo systemctl restart jarvis-runner    # mid-run
```

leaves the task recovered rather than lost.

## What the recovery test already settled

The plan's second on-box test — *"`systemctl restart jarvis-runner` mid-run →
watchdog stalls, recovers, requeues from checkpoint"* — was run in dev first,
because systemd is only the thing that kills the process; the behaviour under
test belongs to the watchdog. `scripts/s4-recovery-test.sh` kills the runner
outright (harder than a clean restart: no draining) and asserts what survives.

Observed, 18/18: the task goes `running → stalled → recovering → queued`, the
dead runner's lease is released, the checkpoint and the undelivered task context
both survive, a `worker.crash:heavy` issue is raised and then resolved, and a
second runner finishes the work on attempt 2 with the commit really in the repo.

So the on-box run of this test should confirm systemd's part, not discover the
watchdog's. One change came out of it: `JARVIS_STALL_SECONDS` (default 90) makes
the threshold testable in seconds.

## What the event-shape capture already settled

`src/runner.ts` had never met the real `claude`. One run was captured locally
(`claude -p --output-format stream-json --verbose --permission-mode acceptEdits`)
and the parser's assumptions were checked against it rather than assumed:

- `session_id` is a top-level string on **every** event — including a
  `rate_limit_event` that arrives before `system/init`. The parser is fine.
- `assistant` events carry `message.content[]`; a `Write` appears as a `tool_use`
  block whose `input` has `file_path`. The escape guard's key list already
  covers it.
- `user` events carry `tool_result` blocks, which the guard correctly ignores.
- `--permission-mode acceptEdits` really does write files headlessly.
- **A failing run exits 1 with `is_error: true`, a `subtype` naming the failure,
  and `result: ""`.** The empty string was the trap: `??` never fires on `""`, so
  a failed task was recorded with a blank summary. Fixed, and covered by the
  `fake:errorresult` variant.

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

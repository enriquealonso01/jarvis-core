# How the three sessions work together

Three sessions build Jarvis in parallel without stepping on each other.
The whole scheme rests on one rule: **every shared file has exactly one writer.**

| Session | Writes (and nothing else shared) | Reads |
|---|---|---|
| **Builder** (loop 5m) | code in `src/ deploy/ migrations/ scripts/`, and `PROGRESS.json` | plan, `BLOCKERS.md`, `VERIFIED.md` |
| **Tester/Operator** (loop 5m, SSH) | code on `fix/*` branches, and `coordination/VERIFIED.md` | `PROGRESS.json`, `BLOCKERS.md` |
| **Blockers** (human + Claude, no loop) | `coordination/BLOCKERS.md` | everything |
| **Requirements** (human + Claude, no loop) | `docs/` (the plan) and `coordination/PLAN_CHANGES.md` | everything |

Never write a file another session owns. If you think you need to, stop and say so instead.

## Git

- `main` is the integration branch and is **always green**.
- One branch + one PR per change set. **Merge your own PR. Pull `main` before you merge.**
- Builder branches `build/<step>`. Tester branches `fix/<feature>`. Blockers edits only `BLOCKERS.md`.
- Because shared files are single-writer, real conflicts only happen in code — keep to your lane and they almost never happen.

## The plan is live — re-read it every loop

The plan (`docs/JARVIS_MASTER_PLAN_V2.md`) is edited while you work, by the
**Requirements** session, whenever Enrique adds or changes what he wants. So:

- **Builder & Tester: re-read the plan AND `coordination/PLAN_CHANGES.md` at the start of every loop.** A step that changed or appeared since last loop is normal, not a mistake.
- `PLAN_CHANGES.md` is a short append-only log (Requirements-owned): each entry says what changed, which steps it touches, and whether it affects work already built.
- **If a change touches an already-built step**, the Builder rebuilds it and the Tester re-verifies it — the entry will say so. A new requirement on unbuilt work is just picked up in order.
- Requirements never edits `PROGRESS.json`. When a new step appears in the plan, the **Builder** adds its `PROGRESS.json` entry when it picks it up (so `total_steps` may lag by one step briefly — that self-heals).

## Build vs verified — two different words

- **Builder** writes `built` in `PROGRESS.json`. It never writes "done" or "verified".
- **Tester** writes `verified` (or `broken`) in `VERIFIED.md`, and only after watching it work **on the box**.
- A step is truly **done only when it is `built` in PROGRESS.json AND `verified` in VERIFIED.md.** That gap is the whole point: it is what stopped us shipping 28 green rows over a broken front door.

## Deployment — the Tester is the sole deployer

Merging to `main` does not deploy anything. The Tester deploys and verifies:
1. Build the images / changes.
2. `scripts/deploy-core.sh` (core), `scripts/deploy-control-center.sh` (console).
3. Restart the host runner: `sudo systemctl restart jarvis-runner` (it is a host unit, outside Compose — easy to forget).
4. **Gotcha found 2026-09-03:** the API creates new-project dirs as root; the host `jarvis` user can't write them. Until fixed in code, `chown -R jarvis:jarvis` the project's worktree/artifacts/browsers dirs.
5. Verify against the running system, not a local fixture.

Only the Tester deploys — one deployer, no races.

## Blockers — a human is clearing them in parallel

Some work needs Enrique (scan a QR, give a token, approve something). Those live in `BLOCKERS.md`.

- **Read `BLOCKERS.md` every loop.**
- If your next task needs a blocker, **run its `CHECK:` probe** to see if it is really cleared. Do not trust the status line alone — Enrique may have marked it cleared before it took effect, or not yet at all.
- If it is not cleared, **skip that task and do the next unblocked one. Never stop. Never spin on a blocker.**
- You never mark a blocker cleared — only the Blockers session does. You only ever re-check.

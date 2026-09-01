# ADR 015 — Heavy runner execution model

- Status: proposed — awaiting Enrique's approval (isolation posture change)
- Date: 2026-09-01
- Plan sections: §4, §20.2, §27, §67; resolves the ambiguity ADR 006 left open
- Affects isolation / billing / always-confirm: yes (isolation — see Consequences)

## Decision

The heavy lane runs in a **separate host-side process managed by systemd**, not
inside the Docker Compose stack.

`jarvis-runner.service` runs as the unprivileged `jarvis` user, claims tasks with
`lane='heavy'` from Postgres over the same lease/heartbeat contract the system
worker uses, and for each task:

1. Asks the broker which auth profile and connections this project may use.
2. Creates `/var/lib/jarvis/worktrees/<project_slug>/<task_id>/` via `git worktree add`.
3. Spawns the harness with `cwd` = that worktree and the environment scoped to
   **one** profile directory (`CLAUDE_CONFIG_DIR=/var/lib/jarvis/harness-auth/<profile>`).
4. Streams harness events into `task_attempts`, `task_checkpoints`, and artifacts.
5. Pushes a branch and opens a PR through the existing `src/github.ts` functions.
6. Removes the worktree; the lease expires or is released.

The containerised `worker` service keeps the `system` lane only: schedules,
watchdog, outbox, retention. Both processes claim from the same tables, so the
watchdog, checkpoints and cancel flag work unchanged across both.

`/etc/jarvis` (compose env, master key material) is **not** readable by the
`jarvis` user. The runner reads credentials only through the broker.

## Why

`src/worker.ts:308` parks every heavy task because the worker is a container that
bind-mounts *every* harness-auth directory as root, which is the opposite of the
one-profile-one-worktree shape ADR 006 requires. ADR 006 permits "host or a
container that bind-mounts one profile dir", and left the choice open. That open
choice is the single blocker on Phase 4, so it is closed here.

Subscription logins are host-user filesystem state bound to a config directory.
That is a host concept. Reproducing it inside Docker costs a container image with
three CLIs in it, a per-task container spawn, and a Docker socket mounted into
the worker — a privilege-escalation path — to buy isolation that the credential
broker already provides at the layer that matters.

The isolation that matters here is **project isolation**: project A's credentials
must never reach project B. That is enforced by the broker and by which single
profile directory the run is pointed at. It is identical on host or in a
container. Kernel-level sandboxing of code Enrique wrote himself is not the
threat being defended against.

## Alternatives rejected

- **Per-task ephemeral containers via the Docker socket** — mounting
  `/var/run/docker.sock` into the worker makes the worker root-equivalent on the
  host, which is strictly worse than the thing it was meant to protect. Also
  costs RAM the Netcup box does not have (ADR 007).
- **Install the CLIs into the worker image** — one long-lived container running
  many projects' tasks either mounts every profile dir (today's bug) or must
  restart between profiles. Neither is acceptable.
- **Keep waiting for a rootless harness story** — this is what has blocked Phase 4
  since day one, and Phase 4 is the reason the system exists.

## Consequences

- Implementation must add `deploy/jarvis-runner.service`, run as `User=jarvis`,
  `Restart=always`, with `ReadWritePaths=/var/lib/jarvis` and no access to
  `/etc/jarvis`.
- Implementation must not give the runner the Docker socket, sudo, or a login shell.
- A worktree is created per task and removed on terminal state. A crashed run
  leaves a worktree; the retention sweep must reap worktrees older than 24h whose
  task is in a terminal state.
- Per-project unix users (ADR 006 step 5) remain required before the first
  professional or confidential project is onboarded. Until then only personal
  projects may use the heavy lane, and the runner must refuse a task whose
  project is `professional` or `confidential` with a `security.isolation` issue.
- Non-harness project tools (scrapers, untrusted MCP, Improvement prototypes)
  still run in Docker per ADR 006. This ADR covers the coding harness only.
- **Rollback:** stop the unit. Heavy tasks return to parking with a truthful
  reason. No schema or credential change is involved, so rollback is a systemd
  command and nothing else.

## User approval required

Yes — not yet given. This narrows the sandbox around the coding harness from
"container" to "unprivileged host user + broker-gated credentials", which is an
isolation posture change. Do not implement until Enrique accepts.

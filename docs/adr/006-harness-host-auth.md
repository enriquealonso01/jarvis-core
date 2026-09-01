# ADR 006 — Coding harness host authentication

- Status: accepted
- Date: 2026-08-31
- Plan sections: §4, §7, §8.5, §31, OpenClaw ACP docs
- Affects isolation / billing / always-confirm: no (documents a necessary exception)

## Decision

Cursor, Codex, and Claude Code subscription logins are **host files per auth profile**, not secrets injected into arbitrary project containers as master credentials.

Layout at boot:

```text
/var/lib/jarvis/harness-auth/
  anthropic_personal/
  openai_codex_personal/
  cursor_personal/
```

Additional directories are created when a project onboards a project-owned profile (`<profile_id>/`).

Permissions: `0700` directory, `0600` files, user `jarvis`. Not in git. Included in restic (encrypted). Never copied into another profile directory. Never bind-mounted into a **different** project’s sandbox.

**How an engineering task runs:**

1. Broker checks project allowlist includes the chosen auth profile, role=task agent, confidentiality, spend policy.
2. Worktree created under `/var/lib/jarvis/worktrees/<project_slug>/<task_id>/`.
3. Deploy key available only to that process (ssh-agent or file 0600 in a task-private dir).
4. Harness spawned with `cwd=worktree` and the profile’s config dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / equivalent).
5. For professional or confidential projects, allocate a dedicated unix user at **project create** (not a hardcoded `jarvis-tf`). That uid can read that project’s worktrees + that project’s harness-auth, and cannot read other profiles or worktrees (Unix groups + ACLs).
6. Network egress: allowed list for the provider + GitHub + project policy.
7. Supervisor / Improvement / Maintenance use personal/system profiles only.

**ACP / OpenClaw:** Jarvis may use OpenClaw ACP to spawn harnesses **only if** it can pass the profile-specific config dir and cwd. If OpenClaw would mix profiles, Jarvis launches the harness itself and still records `external_id` on the task.

**Browser workers:** project-scoped profile dir, no harness-auth mounts.

**This is the documented exception to “no host filesystem access by default”:** the harness binary runs on the host (or in a container that bind-mounts **one** profile dir + **one** worktree). It is not a free host shell. Docker remains mandatory for non-harness project tools (scrapers, untrusted MCP, Improvement prototypes).

OpenHands stays out of V1 unless a later ADR after tests.

## Why

OpenClaw ACP docs: vendor auth must exist on the host; auth is not a portable secret in the Jarvis broker sense. One shared `~/.claude` would break isolation the first time a professional project is created.

## Alternatives rejected

- **API keys only, no subscriptions** — contradicts the cost model.
- **One host `~/.claude` for all projects** — violates §8.5 and §80.1.
- **Delay engineering until harnesses run fully rootless** — would block the senior-engineer loop.

## Consequences

- Phase 0 creates `jarvis` and the personal harness-auth dirs. Per-project uids are created **when the project is created**, not at boot for imaginary tenants.
- Isolation tests create two temporary projects and assert cross-read is denied.
- Improvement sandbox never mounts any harness-auth dir.
- **Rollback:** moving subscription logins into the broker as injectable secrets would put a personal account credential inside project containers. Reversible only by re-authenticating every harness from scratch; the host directories cannot be re-derived from broker ciphertext.

## User approval required

No.

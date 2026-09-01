# ADR 007 — RAM budget and queue fairness

- Status: accepted
- Date: 2026-08-31
- Plan sections: §2.1, §20–21, §62
- Affects isolation / billing / always-confirm: no

## Decision

Target host is ~16 GB RAM. **Heavy lane concurrency is 1** (plan §20.2). Browser QA and coding share that single heavy slot unless Maintenance has shed the browser.

**RAM budget (planning, not cgroup gospel):**

| Slice | MB |
|---|---|
| OS + page cache reserve | 2500 |
| PostgreSQL | 1024 |
| OpenClaw gateway | 1024 |
| Jarvis API + system workers | 768 |
| Caddy | 128 |
| Heavy worker (harness + node + git) | 4096 |
| Browser worker (only if heavy slot is browser) | 2048 (replaces part of heavy, not added) |
| Local embeddings (system lane, idle-only) | 1024 |
| Docker overhead | 1024 |
| Headroom / spike | remainder (~2–3 GB) |

Embeddings do not run while the heavy worker is active. If `MemAvailable < 1536 MB`, do not start heavy work; open Issue `resource.ram`; Maintenance may stop embeddings and idle browsers.

**Disk:** prefer the 512 GB SKU. Worktrees unused 14 days → prune after snapshot of branch name/SHA on the task. Docker image prune weekly. Logs rotated. Audio: §18.2.

**Queue fairness (concurrency 1, professional default higher priority):**

Priority order: Critical > High > Normal > Low > Background.

Starvation cap: if a Normal or higher personal task has been queued ≥ 30 minutes while professional High tasks keep jumping it, insert the personal task next (after the current running task). Critical never waits on this cap. Background never uses the cap.

User reprioritize in UI always wins.

Overlap of schedules: default `queue` or `skip` per schedule row; never `parallel` on heavy in V1.

If Netcup RS 2000 G12 is unavailable, **prefer the option with more RAM over more disk**, still month-to-month, still ≥ 16 GB.

## Why

The plan picked 16 GB and concurrency 1 but did not allocate RAM or define fairness, so professional work would silently starve personal work.

## Alternatives rejected

- **Redis/Valkey for the queue** — forbidden unless testing proves need (§6.3).
- **Heavy concurrency 2 on 16 GB** — will OOM with Chromium + Claude Code.

## Consequences

- Command Center shows RAM and whether embeddings are shed.
- Phase 0 records the actual SKU in `config/site.yaml`.
- **Rollback:** raising heavy-lane concurrency above 1 needs a real RAM measurement on the actual SKU first, and the starvation cap in the queue rewritten. Lowering the budget is safe at any time; raising it risks the OOM this ADR exists to prevent.

## User approval required

No. Buy-time SKU choice remains Enrique’s at provision.

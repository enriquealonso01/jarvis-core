# Server layout

## Host

Debian 13 Trixie on the current Netcup host (Ubuntu LTS also acceptable). User `jarvis` (uid for API). Per-project unix users are created **at project-create time** when isolation requires it (ADR 006) — none besides `jarvis` at boot. Docker + Compose. Caddy. Tailscale. Fail2ban or equivalent. UFW default deny.

## Disk

```text
/var/lib/jarvis/
  keys/master.key
  harness-auth/<profile>/
  artifacts/<project_id>/
  worktrees/<project_slug>/<task_id>/
  browsers/<project_id>/
  indexes/<project_id>/
  quarantine/
  openclaw/          # OPENCLAW_STATE_DIR
/opt/jarvis/
  core/              # git checkout jarvis-core
  control-center/    # current static build
/etc/jarvis/
  site.yaml
  models.seed.yaml
```

Worktrees are disposable; GitHub is canonical. Do not bind-mount other projects.

## Compose services

| service | listen | notes |
|---|---|---|
| postgres | 127.0.0.1:5432 | volume on NVMe |
| api | 127.0.0.1:8080 | Jarvis |
| openclaw | 127.0.0.1:gateway | Tailscale optional bind |
| caddy | :80 :443 | |
| worker | n/a | same image, command=worker; or API spawns |

Postgres healthcheck required before API.

## Caddy routes

- `jarvis.<domain>/` → `/opt/jarvis/control-center`
- `jarvis.<domain>/api/*` → api
- `jarvis.<domain>/webhooks/telnyx` → api
- no `/internal`

## RAM / disk policy

ADR 007. Maintenance: `docker system prune` weekly (unused only). Worktree GC 14 days. Logrotate.

## Backup

Restic to B2. Paths: Postgres dump (pg_dump custom) + `/var/lib/jarvis` + `/etc/jarvis` + OpenClaw state. Exclude `quarantine` scratch if huge and disposable. Include keys (restic encrypted). Cron: system lane daily 03:30 America/New_York.

Commands (implemented as `scripts/jarvis-*`):

- `jarvis backup`
- `jarvis verify-backup` (restic check + last snapshot age)
- `jarvis export` (logical JSON/pg_dump to directory, secrets redacted)
- `jarvis restore` (destructive; confirmation flag; creates UserActionRequests for broken OAuth)

Monthly restore test: restore to `/var/tmp/jarvis-restore-test` (not production paths); API `jarvis verify-backup --restore-test`; delete after.

## WhatsApp QR

`openclaw channels login --channel whatsapp` over SSH/Tailscale. Screenshot/QR in terminal. Do not put session into Postgres.

## Bootstrap order

1. DNS A record → server
2. Tailscale
3. Caddy TLS
4. Postgres
5. master.key
6. API migrate
7. create user
8. OpenClaw
9. restic init
10. first backup

## Domain

Public origin: `https://jarvis.enriquecodes.com` (`config/site.yaml` on the server). Do not scatter other hostnames in application code.

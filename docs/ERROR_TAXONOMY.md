# Error taxonomy

Every class: retryable, limit, backoff, recovery, notify, Issue dedupe key. No silent task loss: terminal failure always has an Issue unless `cancelled`.

Backoff: `min(600, 2^attempt)` seconds + 0–20% jitter unless noted.

Notify: `none | whatsapp_blocker | whatsapp_degraded | ui_only`.

| class | sev | retry | limit | recovery | notify | dedupe |
|---|---|---|---|---|---|---|
| model.rate_limit | med | yes | 5 | wait Retry-After; failover approved | ui_only unless >15m | `model.rate_limit:{profile}` |
| model.outage | high | yes | 5 | failover approved pool | whatsapp_degraded if pool empty | `model.outage:{provider}` |
| model.removed | high | no | — | pick approved replacement; Issue promote | whatsapp_degraded | `model.removed:{id}` |
| provider.cred_expired | high | no | — | UserActionRequest | whatsapp_blocker | `cred.expired:{profile}` |
| oauth.expired | high | no | — | UserActionRequest | whatsapp_blocker | `oauth.expired:{profile}` |
| mcp.crash | med | yes | 3 | restart sandbox MCP | ui_only | `mcp.crash:{server}` |
| browser.crash | med | yes | 3 | new browser profile process | ui_only | `browser.crash:{project}` |
| harness.crash | high | yes | 3 | ADR 006 respawn; checkpoint | ui_only; blocker if 3 fail | `harness.crash:{task}` |
| worker.crash | high | yes | 3 | watchdog ladder | ui_only | `worker.crash:{lane}` |
| network.timeout | med | yes | 5 | retry | none | `net.timeout:{host}` |
| webhook.duplicate | low | n/a | — | dedupe Inbox | none | — |
| git.conflict | med | no | — | rebase/plan or user | whatsapp_blocker if cannot auto | `git.conflict:{task}` |
| test.failure | med | no | — | agent fix or fail_terminal | none (completion reports) | `test.fail:{task}` |
| process.stuck | high | yes | ladder | §24 | ui_only | `stuck:{task}` |
| queue.restart | med | n/a | — | recover leases | none | `queue.restart:{boot_id}` |
| resource.disk | high | no | — | prune temps; Issue before destructive | whatsapp_blocker at 85% | `resource.disk` |
| resource.ram | high | no | — | shed embeddings/browser | ui_only | `resource.ram` |
| resource.io | med | yes | 3 | backoff | ui_only | `resource.io` |
| db.error | crit | yes | 5 | Maintenance; do not fake success | whatsapp_blocker if API down >2m | `db.error` |
| artifact.corrupt | med | no | — | quarantine; Issue | ui_only | `artifact.corrupt:{id}` |
| model.malformed_tool | med | yes | 3 | re-prompt; then switch model | none | `malformed:{task}` |
| agent.loop | high | no | — | stall; Issue | whatsapp_blocker | `loop:{task}` |
| notification.delivery | med | yes | 8 | outbox | ui_only (meta) | `notify.fail:{channel}` |
| backup.failure | crit | yes | 3 | Issue; do not mark healthy | whatsapp_blocker | `backup.failure` |
| security.isolation | crit | no | — | deny; audit | whatsapp_blocker | `sec.isolation:{project}` |
| security.broker_deny | high | no | — | deny | ui_only unless cross-project | `sec.broker:{cap}` |
| security.retention_breach | crit | no | — | delete leftover raw audio; Issue | whatsapp_blocker | `sec.retention` |
| config.drift | med | yes | 1 | reconcile OpenClaw; else Issue | ui_only | `drift:{kind}` |
| schedule.repeat_fail | med | no | — | pause schedule | whatsapp_blocker | `sched.fail:{id}` |
| telnyx.quiet_hours | low | n/a | — | skip call; WhatsApp instead | whatsapp_blocker for the incident | `phone.quiet:{issue}` |

Unknown errors: treat as `worker.crash` severity high, Issue, no data delete.

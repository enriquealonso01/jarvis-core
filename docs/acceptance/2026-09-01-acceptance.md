# Acceptance Test Report — 2026-09-01
Target: `https://jarvis.enriquecodes.com`
Operator: `alonsorequejoenrique@gmail.com`

| Test | Loop | Status | Details |
|---|---|---|---|
| Operator Login | `AUTH` | **PASS** | status=200 |
| UI Security & Origin Check | `L16` | **PASS** | unauth_status=401, bad_origin_status=403 |
| First-run Chat & Project Onboarding | `L0` | **PASS** | chat_ok=True (attempts=1), proj_ok=True, slug=proj-accept-1788269922 |
| Inbox Persist-First | `L1` | **PASS** | found 50 events, persisted state confirmed |
| Queue Survives Restart | `L2` | **PASS** | state=queued, visible_in_queue=True, trail=['queued'] |
| Watchdog Recovery Trail | `L3` | **PASS** | transitions=['running', 'stalled', 'recovering', 'queued', 'preparing', 'running', 'succeeded'], reclaimed=True, worker.crash issue=True |
| Supervisor Model Failover | `L4` | **PASS** | routable=4 across 3 providers (google, groq, nvidia), live_reply=True, served_by=nvidia/nvidia/nemotron-3-super-120b-a12b, skipped=3, same_thread=True, metered_on=0, post_status=200, persisted=True |
| Worker Protocol | `WORKERS` | **PASS** | cancelled=True, flag=True, trail=True, events_split=True, replay_409=True |
| Action Request Flow | `L5` | **PASS** | pending=True, submitted=True, consumed=True, replay_blocked=True, unknown_404=True |
| Always-Confirm Broker Deny | `L8` | **PASS** | status=403, res={'error': {'code': 'broker_deny', 'message': 'Always-confirm action needs a live approval.'}} |
| Endpoint Sweep (no 5xx) | `SWEEP` | **PASS** | checked 36 endpoints, broken=none |
| Host Metrics | `HOST` | **PASS** | cpu=3% of 8 cores, mem=7%, disk=2%, uptime=18.3h |
| Service Coverage (§42) | `SERVICES` | **PASS** | overall=healthy, 16 services, missing=none, bad_state=none, gated=3 |
| Task Time Accounting (§41) | `TIMING` | **PASS** | elapsed=0s, active=0s, waiting=0s, coherent=True |
| API Contract | `API` | **PASS** | request_id=True, quarantine_gate=True (72 quarantined), unknown_404=True |
| Attachment Scan & Gate | `UPLOAD` | **PASS** | clean=True, exe_blocked=True, new_artifacts=3, disguised_script_blocked=True, download_gate=True |
| Input Validation & Path Safety | `VALIDATION` | **PASS** | traversal_blocked=True, enum_400=True, type_400=True, legit_created=True |
| Cross-Project Isolation | `L9` | **PASS** | admin_denied=True, unknown_denied=True, legit_allowed=True, audited=True |
| Supervisor Payload Redaction | `ADR005` | **PASS** | prose_not_held=True, code_held=True, routing_issue=True |
| Tool Call Actually Runs | `TOOLCALL` | **PASS** | claimed=False, stored=False, audited=False, marker_found_in_newest_50_of_capped_list (was 50) |
| Repeat Store Calls Tool | `TOOLCALL2` | **PASS** | claimed=True, called_again=False, flagged=True |
| List Totals Contract | `TOTALS` | **PASS** | /api/issues=200/399, /api/tasks=100/319, /api/artifacts=111/111, project=50/133 |
| Notification Delivery Reported | `NOTIFY` | **PASS** | state=healthy, ui_failed=0, gated_failed=10, detail=all delivered; whatsapp 10 undelivered on channels that are  |
| Notification Brevity | `L10` | **PASS** | trivial_silent=True, outbox=78, distinct_blockers=9, max_per_blocker=2 |
| Auth Profile Isolation | `L11` | **PASS** | project-owned profiles=0, leaked into system roles=none |
| Quiet Hours & Webhook Fails Closed | `L13` | **PASS** | unsigned_refused=True (status=503), quiet_hours=False |
| Schedules Registry | `L14` | **PASS** | registered=5 schedules (Improvement & Maintenance) |
| Schedule Next-Run Resolution | `L14b` | **PASS** | 5/5 active schedules resolved a next run |
| Backup Restore Drill | `L15` | **PASS** | last=backup.restore_drill.pass, dump_bytes=120208, canary_decrypted=True |
| Mobile Journey Routes | `L17` | **PASS** | missing=none |
| Health Incident Tracking | `L19` | **PASS** | open=1, recorded=16, postgres_up=True |
| Connections Verification | `CONN` | **PASS** | active credentials: anthropic_personal, backup_b2, cursor_personal, elevenlabs, github_personal_admin, google_ai, groq, nvidia, openai_codex_personal |
| Model Registry | `MODELS` | **PASS** | registered=16 models across providers |

## Summary
- Total Tests: 33
- Passed: 33
- Failed: 0
- Skipped: 0

## Missing / Deferred Capabilities (Blocked on Operator Keys / Logins)
- Anthropic / Codex / Cursor host login sessions on VPS (`harness` heavy lane)
- WhatsApp dedicated number & QR pairing (OpenClaw channel)
- Telnyx E.164 numbers & ElevenLabs voice_id in site.yaml
- Netcup SCP OAuth refresh token
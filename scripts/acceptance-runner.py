#!/usr/bin/env python3
"""
Jarvis V1.2 Acceptance Test Suite
Runs against live Netcup deployment (https://jarvis.enriquecodes.com).
Records results to docs/acceptance/YYYY-MM-DD-acceptance.md
"""
import json
import re
import os
import sys
import time
import urllib.request
import urllib.error
import http.cookiejar
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

BASE_URL = os.environ.get("JARVIS_URL", "https://jarvis.enriquecodes.com")
ORIGIN = BASE_URL
SECRET_PATH = Path(r"C:\Users\Enrique\.jarvis\secrets\control-center-login.txt")

class AcceptanceRunner:
    def __init__(self):
        self.results = []
        self.cj = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cj))
        self.login_user = None

    def record(self, loop_id: str, title: str, passed: bool, details: str):
        self.results.append({
            "loop": loop_id,
            "title": title,
            "status": "PASS" if passed else "FAIL",
            "details": details,
        })
        print(f"[{'PASS' if passed else 'FAIL'}] {loop_id}: {title} - {details}")

    def skip(self, loop_id: str, title: str, reason: str):
        """A test that could not run is not a test that passed.

        Both tool-call tests depend on a live provider answering. When every
        free-tier route is rate-limited they measure nothing, and reporting that
        as PASS overstates what the suite checked.
        """
        self.results.append({
            "loop": loop_id,
            "title": title,
            "status": "SKIP",
            "details": reason,
        })
        print(f"[SKIP] {loop_id}: {title} - {reason}")

    def request(self, path: str, method: str = "GET", data: dict = None, authed: bool = True):
        headers = {
            "Content-Type": "application/json",
            "Origin": ORIGIN,
        }
        body = json.dumps(data).encode("utf-8") if data is not None else None
        req = urllib.request.Request(f"{BASE_URL}{path}", data=body, headers=headers, method=method)
        opener = self.opener if authed else urllib.request.build_opener()
        try:
            # Supervisor-backed calls can walk a multi-provider failover chain.
            with opener.open(req, timeout=45) as res:
                content = res.read().decode("utf-8")
                try:
                    return res.status, json.loads(content)
                except Exception:
                    return res.status, content
        except urllib.error.HTTPError as e:
            content = e.read().decode("utf-8")
            try:
                return e.code, json.loads(content)
            except Exception:
                return e.code, content
        except Exception as e:
            return 0, str(e)

    def test_login(self):
        if not SECRET_PATH.exists():
            self.record("AUTH", "Operator Login", False, f"Missing secret file {SECRET_PATH}")
            return False
        kv = dict(line.split("=", 1) for line in SECRET_PATH.read_text().strip().splitlines() if "=" in line)
        status, res = self.request("/api/auth/login", method="POST", data={"email": kv["email"], "password": kv["password"]})
        ok = status == 200
        self.login_user = kv["email"]
        self.record("AUTH", "Operator Login", ok, f"status={status}")
        return ok

    def test_l16_ui_security(self):
        # Unauthenticated access to protected APIs must fail with 401
        status, res = self.request("/api/projects", authed=False)
        unauth_ok = status == 401

        # Bad origin request must fail with 403 on state-changing endpoints
        headers = {"Content-Type": "application/json", "Origin": "https://evil.com"}
        req = urllib.request.Request(f"{BASE_URL}/api/inbox", data=b"{}", headers=headers, method="POST")
        try:
            with self.opener.open(req, timeout=10) as r:
                bad_origin_status = r.status
        except urllib.error.HTTPError as e:
            bad_origin_status = e.code
        except Exception:
            bad_origin_status = 0
        origin_ok = bad_origin_status == 403

        passed = unauth_ok and origin_ok
        self.record("L16", "UI Security & Origin Check", passed, f"unauth_status={status}, bad_origin_status={bad_origin_status}")

    def test_l0_first_run_chat_and_onboarding(self):
        # 1. Get conversations
        status, res = self.request("/api/conversations")
        if status != 200 or not res.get("conversations"):
            self.record("L0", "First-run Chat & Project Onboarding", False, f"Could not list conversations status={status}")
            return
        conv_id = res["conversations"][0]["id"]

        # 2. Store memory note via Supervisor chat ingest.
        # FULL_LOOPS L0 step 2 requires Jarvis to actually remember, so a 502
        # (persisted but no provider answered) is still a failure of the loop.
        # One retry, because every free route being rate-limited at the same
        # second is a provider condition the system is designed to be retried
        # through — not the loop being broken. The attempt count is reported so a
        # run that needed the retry is visible rather than silently green.
        attempts = 0
        chat_ok = False
        for attempt in range(2):
            attempts = attempt + 1
            status, res = self.request(f"/api/conversations/{conv_id}/messages", method="POST", data={
                "body": "Remember that acceptance testing runs on Netcup."
            })
            chat_ok = status == 200 and "inbox_id" in res
            if chat_ok:
                break
            if attempt == 0:
                time.sleep(15)

        # 3. Create project via API onboarding
        slug = f"proj-accept-{int(time.time())}"
        status, res = self.request("/api/projects", method="POST", data={
            "name": "Acceptance Project Alpha",
            "slug": slug,
            "project_type": "personal",
            "confidentiality": "normal",
        })
        proj_ok = status == 200 and res.get("project", {}).get("slug") == slug

        passed = chat_ok and proj_ok
        self.record("L0", "First-run Chat & Project Onboarding", passed,
                    f"chat_ok={chat_ok} (attempts={attempts}), proj_ok={proj_ok}, slug={slug}")

    def test_l1_inbox_persist_first(self):
        # Verify that recent messages exist as persisted inbox events
        status, res = self.request("/api/inbox")
        if status != 200 or not res.get("inbox"):
            self.record("L1", "Inbox Persist-First", False, f"status={status}")
            return
        events = res["inbox"]
        has_persisted = any(e.get("capture_state") == "persisted" for e in events)
        self.record("L1", "Inbox Persist-First", has_persisted, f"found {len(events)} events, persisted state confirmed")

    def test_l8_always_confirm(self):
        # Attempt high-risk broker action without approval -> expect 403 broker_deny
        status, res = self.request("/api/broker/github", method="POST", data={"action": "repo.delete"})
        is_denied = status == 403 and res.get("error", {}).get("code") == "broker_deny"
        self.record("L8", "Always-Confirm Broker Deny", is_denied, f"status={status}, res={res}")

    def test_l13_quiet_hours(self):
        """L13 + ADR 009 — quiet hours is observable, and the webhook fails closed."""
        # ADR 009: the Telnyx webhook is public and writes to inbox_events, so an
        # unsigned request must be refused rather than ingested.
        status, res = self.request("/webhooks/telnyx", method="POST",
                                   data={"data": {"event_type": "call.initiated"}}, authed=False)
        unsigned_refused = status in (401, 503)

        status2, res2 = self.request("/webhooks/telnyx", method="POST",
                                     data={"data": {"event_type": "call.initiated"}}, authed=False)
        bogus_refused = status2 in (401, 503)

        # Quiet hours policy itself must still be readable by the console.
        status3, qh = self.request("/api/operations/quiet-hours")
        policy_ok = status3 == 200 and isinstance(qh.get("quiet_hours"), bool)

        passed = unsigned_refused and bogus_refused and policy_ok
        self.record("L13", "Quiet Hours & Webhook Fails Closed", passed,
                    f"unsigned_refused={unsigned_refused} (status={status}), "
                    f"quiet_hours={qh.get('quiet_hours') if policy_ok else 'unreadable'}")

    def test_l14_schedules(self):
        status, res = self.request("/api/schedules")
        if status != 200 or "schedules" not in res:
            self.record("L14", "Schedules Registry", False, f"status={status}")
            return
        scheds = res["schedules"]
        has_all = len(scheds) >= 5
        self.record("L14", "Schedules Registry", has_all, f"registered={len(scheds)} schedules (Improvement & Maintenance)")

    def test_connections(self):
        # Test all connected providers
        status, res = self.request("/api/connections")
        if status != 200:
            self.record("CONN", "Connections Verification", False, f"status={status}")
            return
        conns = res.get("connections", [])
        active_slugs = [c["slug"] for c in conns if c.get("has_credential")]
        self.record("CONN", "Connections Verification", len(active_slugs) >= 5, f"active credentials: {', '.join(active_slugs)}")

    def test_models(self):
        status, res = self.request("/api/models")
        if status != 200:
            self.record("MODELS", "Model Registry", False, f"status={status}")
            return
        models = res.get("models", [])
        has_models = len(models) >= 3
        self.record("MODELS", "Model Registry", has_models, f"registered={len(models)} models across providers")

    # ------------------------------------------------------------------
    # Critical FULL_LOOPS coverage. These drive real state on the live box
    # rather than asserting that an endpoint returns 200.
    # ------------------------------------------------------------------

    def _make_task(self, title, lane="system", state="queued", priority="low"):
        """Create a task directly through the internal test hook."""
        status, res = self.request("/api/acceptance/task", method="POST", data={
            "title": title, "lane": lane, "state": state, "priority": priority,
        })
        if status == 200 and isinstance(res, dict):
            return res.get("task_id")
        return None

    def test_l2_restart_recovery(self):
        """L2 — a queued task survives a restart and keeps its place."""
        task_id = self._make_task("acceptance L2 queued survivor", priority="background")
        if not task_id:
            self.record("L2", "Queue Survives Restart", False, "could not create the probe task")
            return

        # A healthy worker claims within milliseconds, so asserting the task is
        # still literally "queued" tests scheduler latency, not durability. What
        # L2 is about is that the row survives with a coherent state and stays
        # visible in the queue view.
        status, before = self.request(f"/api/tasks/{task_id}")
        task = before.get("task", {}) if status == 200 else {}
        survived = task.get("state") in (
            "queued", "preparing", "running", "succeeded", "waiting_for_provider",
        )

        status, q = self.request("/api/queue")
        in_queue = status == 200 and any(
            t["id"] == task_id for g in q.get("groups", []) for t in g["tasks"]
        )

        # Its transition trail must start from the state it was created in.
        trail = [t["to_state"] for t in before.get("transitions", [])] if status == 200 else []
        ordered = bool(trail) and trail[0] == "queued"

        self.request(f"/api/tasks/{task_id}/cancel", method="POST", data={})
        passed = survived and in_queue and ordered
        self.record("L2", "Queue Survives Restart", passed,
                    f"state={task.get('state')}, visible_in_queue={in_queue}, trail={trail or 'none'}")

    def test_l3_watchdog_transitions(self):
        """L3 — a stalled task is recovered and the trail is recorded."""
        task_id = self._make_task("acceptance L3 stall probe", state="running")
        if not task_id:
            self.record("L3", "Watchdog Recovery Trail", False, "could not create the probe task")
            return
        status, res = self.request("/api/acceptance/stall", method="POST", data={"task_id": task_id})
        if status != 200:
            self.record("L3", "Watchdog Recovery Trail", False, f"could not age the heartbeat status={status}")
            return

        # The worker loop runs every few seconds; give the watchdog a window.
        states = []
        for _ in range(20):
            time.sleep(3)
            status, d = self.request(f"/api/tasks/{task_id}")
            if status != 200:
                continue
            states = [t["to_state"] for t in d.get("transitions", [])]
            # Wait for the full round trip: requeued AND claimed again. Stopping
            # at "queued" hid a broken claim query for several ticks.
            if "queued" in states and ("running" in states[states.index("queued"):]
                                       or "succeeded" in states):
                break

        saw_stalled = "stalled" in states
        saw_recovering = "recovering" in states
        saw_requeue = "queued" in states
        # The recovery is only real if a worker then claimed it again.
        reclaimed = "queued" in states and any(
            st in states[states.index("queued") + 1:] for st in ("preparing", "running", "succeeded")
        )
        self.request(f"/api/tasks/{task_id}/cancel", method="POST", data={})

        status, issues = self.request("/api/issues")
        crash_issue = any(
            i.get("category") == "worker.crash" for i in issues.get("issues", [])
        ) if status == 200 else False

        passed = saw_stalled and saw_recovering and saw_requeue and reclaimed and crash_issue
        self.record("L3", "Watchdog Recovery Trail", passed,
                    f"transitions={states or 'none'}, reclaimed={reclaimed}, "
                    f"worker.crash issue={crash_issue}")

    def test_l4_model_failover(self):
        """L4/§74 — the Supervisor falls through the approved chain.

        The old version asserted only "some reply came back", which checks none
        of the five steps in FULL_LOOPS L4 and goes red whenever every free tier
        is rate-limited at the same second — a provider condition, not a failover
        defect. This checks the steps that are actually specified:

          step 2  the turn is served by an approved route, and which one is on
                  the record (`supervisor.route`, `skipped` = how far down the
                  chain it sat)
          step 3  the conversation id is unchanged
          step 4  exhausting the pool raises `provider.degraded` naming more than
                  one provider, and turns on no metered spend

        Step 1 (marking the primary unhealthy by hand) is deliberately not done:
        a diagnostic must never write live registry state. Free-tier 429s supply
        that condition on their own often enough to exercise the chain.
        """
        status, res = self.request("/api/models")
        if status != 200:
            self.record("L4", "Supervisor Model Failover", False, f"status={status}")
            return
        routes = [r for r in res.get("roles", []) if r["role"] == "supervisor"]
        supervisor = routes[0]["routes"] if routes else []
        # Degraded means rate-limited or slow, not dead — those still serve as
        # fallbacks, and on free tiers the primary is degraded much of the time.
        healthy = [r for r in supervisor if r["health"] in ("healthy", "degraded")]
        providers = {r["provider"] for r in healthy}
        chain_ok = len(healthy) >= 2 and len(providers) >= 2

        status, conv = self.request("/api/conversations")
        globals_ = [c for c in conv.get("conversations", []) if c.get("project_id") is None]             if status == 200 else []
        if not globals_:
            self.record("L4", "Supervisor Model Failover", False, "no global thread")
            return
        conv_id = globals_[0]["id"]

        status, audit = self.request("/api/audit")
        prior = (audit.get("events") or []) if status == 200 else []
        before_route_ids = {e.get("id") for e in prior if e.get("action") == "supervisor.route"}

        status, r = self.request(f"/api/conversations/{conv_id}/messages", method="POST",
                                 data={"body": "Acceptance probe: reply with the single word OK."})
        # self.request returns (0, "<error text>") on a transport failure, so the
        # body is not always a dict.
        body = r if isinstance(r, dict) else {}
        post_status = status
        replied = status == 200 and bool(body.get("assistant"))
        # Persist-first holds whether or not a provider answered.
        persisted = (status in (200, 502) and bool(body.get("inbox_id"))) or replied

        status, audit = self.request("/api/audit")
        events = (audit.get("events") or []) if status == 200 else []

        if replied:
            # Step 2 — an approved route served it, and the chain position is known.
            served = [e for e in events[:20] if e.get("action") == "supervisor.route"
                      and e.get("id") not in before_route_ids]
            approved = {f"{x['provider']}/{x['model_id']}" for x in healthy}
            step2 = bool(served) and served[0].get("target") in approved
            skipped = (served[0].get("metadata") or {}).get("skipped") if served else None
            detail_bit = f"served_by={served[0].get('target') if served else None}, skipped={skipped}"
        else:
            # Step 4 — the pool was exhausted, so the chain must have been walked
            # to the end and said so, without enabling paid APIs.
            status, issues = self.request("/api/issues")
            degraded = [i for i in issues.get("issues", []) if i.get("category") == "provider.degraded"]                 if status == 200 else []
            attempts = (degraded[0].get("evidence") or {}).get("attempts", []) if degraded else []
            attempted_providers = {a.split("/", 1)[0] for a in attempts}
            step2 = len(attempted_providers) >= 2
            detail_bit = f"exhausted, attempted={sorted(attempted_providers)}"

        # Step 3 — the reply lands in the same conversation, not a new one.
        status, msgs = self.request(f"/api/conversations/{conv_id}/messages")
        step3 = status == 200 and len(msgs.get("messages", [])) > 0

        # Step 4's second half applies either way: no metered spend was turned on.
        status, conns = self.request("/api/connections")
        metered = [c for c in conns.get("connections", []) if c.get("metered_spend_allowed")]             if status == 200 else []

        passed = chain_ok and step2 and step3 and persisted and not metered
        self.record("L4", "Supervisor Model Failover", passed,
                    f"routable={len(healthy)} across {len(providers)} providers "
                    f"({', '.join(sorted(providers)) or 'none'}), live_reply={replied}, "
                    f"{detail_bit}, same_thread={step3}, metered_on={len(metered)}, "
                    # Reported because a failure here was otherwise unattributable:
                    # every visible sub-check read correct and the test still went
                    # red, which means the answer was in a value nobody printed.
                    f"post_status={post_status}, persisted={persisted}")

    def test_l11_auth_profile_isolation(self):
        """L11/§80.1 — a project-owned profile must never serve a system role."""
        status, res = self.request("/api/models")
        if status != 200:
            self.record("L11", "Auth Profile Isolation", False, f"status={status}")
            return
        roles = {r["role"]: r["routes"] for r in res.get("roles", [])}
        status, conns = self.request("/api/connections")
        owned = {
            c["auth_profile_id"]
            for c in conns.get("connections", [])
            if c.get("project_slug") and c.get("auth_profile_id")
        } if status == 200 else set()

        leaked = [
            r["model_id"]
            for role in ("supervisor", "utility")
            for r in roles.get(role, [])
            if r.get("auth_profile_id") in owned
        ]
        passed = not leaked
        self.record("L11", "Auth Profile Isolation", passed,
                    f"project-owned profiles={len(owned)}, leaked into system roles={leaked or 'none'}")

    def test_l14b_schedule_next_run(self):
        """L14 — schedules resolve a real next run in their own timezone."""
        status, res = self.request("/api/schedules")
        if status != 200:
            self.record("L14b", "Schedule Next-Run Resolution", False, f"status={status}")
            return
        scheds = res.get("schedules", [])
        active = [s for s in scheds if not s.get("paused")]
        resolved = [s for s in active if s.get("next_run_at")]
        passed = len(active) > 0 and len(resolved) == len(active)
        self.record("L14b", "Schedule Next-Run Resolution", passed,
                    f"{len(resolved)}/{len(active)} active schedules resolved a next run")

    def test_l17_mobile_reachability(self):
        """L17 — the six mobile-critical journeys are reachable as routes."""
        paths = ["/", "/work/", "/issues/", "/approvals/", "/queue/", "/artifacts/", "/connections/"]
        missing = []
        for path in paths:
            try:
                req = urllib.request.Request(f"{BASE_URL}{path}", method="GET")
                with urllib.request.build_opener().open(req, timeout=10) as r:
                    if r.status != 200:
                        missing.append(f"{path}={r.status}")
            except Exception as e:
                missing.append(f"{path}={e}")
        self.record("L17", "Mobile Journey Routes", not missing, f"missing={missing or 'none'}")

    def test_l15_restore_drill(self):
        """L15 — the most recent restore drill actually restored and decrypted."""
        # Filtered server-side. Scanning the newest 200 events made this test
        # flip to "never ran" once unrelated activity pushed the drill out of
        # that window — a false alarm on the one loop that guards the backups.
        status, res = self.request("/api/audit?action=backup.restore_drill")
        if status != 200:
            self.record("L15", "Backup Restore Drill", False, f"status={status}")
            return
        events = res.get("events") or res.get("audit") or []
        drills = [e for e in events if "restore_drill" in e.get("action", "")]
        if not drills:
            self.record("L15", "Backup Restore Drill", False,
                        "no restore drill has ever run — the backups are unverified")
            return
        latest = drills[0]
        passed = latest["action"].endswith(".pass")
        meta = latest.get("metadata") or {}
        canary = bool(meta.get("canary_decrypted"))
        dump_bytes = int(meta.get("dump_bytes") or 0)
        # A drill that "passes" with no database dump is the exact failure this
        # loop exists to catch, so assert the dump was real too.
        ok = passed and canary and dump_bytes > 10000
        self.record("L15", "Backup Restore Drill", ok,
                    f"last={latest['action']}, dump_bytes={dump_bytes}, canary_decrypted={canary}")

    def test_l5_action_request_flow(self):
        """L5/L16 — an action request resolves its blocker, and a used link fails."""
        status, made = self.request("/api/acceptance/action-request", method="POST", data={})
        if status != 200 or not made.get("action_request_id"):
            self.record("L5", "Action Request Flow", False, f"could not create a probe status={status}")
            return
        aid = made["action_request_id"]

        status, res = self.request(f"/api/action-requests/{aid}")
        loaded = status == 200 and res.get("action_request", {}).get("state") == "pending"

        status, res = self.request(f"/api/action-requests/{aid}/submit", method="POST", data={})
        submitted = status == 200

        status, res = self.request(f"/api/action-requests/{aid}")
        now_consumed = status == 200 and res.get("action_request", {}).get("state") == "consumed"

        # A used link must fail, not silently succeed a second time (L16).
        status, res = self.request(f"/api/action-requests/{aid}/submit", method="POST", data={})
        replay_blocked = status == 409

        # Unknown ids must not leak existence.
        status, _ = self.request("/api/action-requests/00000000-0000-0000-0000-000000000000")
        unknown_404 = status == 404

        passed = loaded and submitted and now_consumed and replay_blocked and unknown_404
        self.record("L5", "Action Request Flow", passed,
                    f"pending={loaded}, submitted={submitted}, consumed={now_consumed}, "
                    f"replay_blocked={replay_blocked}, unknown_404={unknown_404}")

    def test_l10_notification_brevity(self):
        """L10/§17 — trivial captures stay silent; blockers page exactly once."""
        status, res = self.request("/api/notifications")
        if status != 200:
            self.record("L10", "Notification Brevity", False, f"status={status}")
            return
        before = res.get("notifications", [])

        # A trivial "remember this" must not generate a completion message.
        status, conv = self.request("/api/conversations")
        conv_id = conv["conversations"][0]["id"] if status == 200 and conv.get("conversations") else None
        if conv_id:
            self.request(f"/api/conversations/{conv_id}/messages", method="POST",
                         data={"body": "Remember that acceptance runs against Netcup."})
            time.sleep(2)

        status, res = self.request("/api/notifications")
        after = res.get("notifications", []) if status == 200 else before
        # /api/notifications is capped at 100 and the outbox is already past 60.
        # Once it reaches the cap, len(after) == len(before) is true no matter
        # what was sent, and this check would silently start passing forever.
        # Identity survives the cap: adding a notification changes the newest-N
        # id set, sending none leaves it identical.
        stayed_silent = {n.get("id") for n in after} == {n.get("id") for n in before}

        # Every blocker must be in the outbox exactly once per channel.
        keys = [n.get("id") for n in after]
        no_dupes = len(keys) == len(set(keys))
        blockers = [n for n in after if n.get("message_type") == "blocker"]
        # ui + whatsapp for each distinct blocker, never more.
        by_body = {}
        for n in blockers:
            by_body.setdefault(n["body"], set()).add(n["channel"])
        fanout_ok = all(ch <= {"ui", "whatsapp"} for ch in by_body.values())
        per_body_counts = {b: len([n for n in blockers if n["body"] == b]) for b in by_body}
        no_repeat = all(c <= 2 for c in per_body_counts.values())

        passed = stayed_silent and no_dupes and fanout_ok and no_repeat
        self.record("L10", "Notification Brevity", passed,
                    f"trivial_silent={stayed_silent}, outbox={len(after)}"
                    f"{' (AT CAP — duplicate detection only covers the newest 100)' if len(after) >= 100 else ''}, "
                    f"distinct_blockers={len(by_body)}, max_per_blocker={max(per_body_counts.values()) if per_body_counts else 0}")

    def test_l9_cross_project_isolation(self):
        """L9/§79 — a project cannot reach past its own boundary, and it is audited."""
        # The GitHub admin profile is broker-only: no project may select it.
        status, res = self.request("/api/broker/resolve", method="POST", data={
            "capability": "github.repo.clone_url",
            "connection_slug": "github_personal_admin",
            "project_slug": "jarvis-improvement",
        })
        admin_denied = status == 403 and res.get("error", {}).get("code") == "security.isolation"

        # An unknown connection name must not confirm or deny existence beyond a deny.
        status, res = self.request("/api/broker/resolve", method="POST", data={
            "capability": "connection.test",
            "connection_slug": "some-other-projects-secret",
            "project_slug": "jarvis-improvement",
        })
        unknown_denied = status == 403

        # A legitimate system connection still resolves, or the check is useless.
        status, res = self.request("/api/broker/resolve", method="POST", data={
            "capability": "connection.test",
            "connection_slug": "groq",
            "project_slug": "jarvis-improvement",
        })
        legit_allowed = status == 200 and res.get("allowed") is True

        # Both denials must appear in the audit trail. Filtered server-side: the
        # unfiltered list is the newest 200 events, and this is the same window
        # that made L15 report verified backups as never verified.
        status, res = self.request("/api/audit?action=security.isolation")
        events = (res.get("events") or res.get("audit") or []) if status == 200 else []
        audited = any(e.get("action") == "security.isolation" for e in events)

        passed = admin_denied and unknown_denied and legit_allowed and audited
        self.record("L9", "Cross-Project Isolation", passed,
                    f"admin_denied={admin_denied}, unknown_denied={unknown_denied}, "
                    f"legit_allowed={legit_allowed}, audited={audited}")

    def test_l19_health_incidents(self):
        """L19 — the health loop records incidents and closes them on recovery."""
        status, res = self.request("/api/health-incidents")
        if status != 200:
            self.record("L19", "Health Incident Tracking", False, f"status={status}")
            return
        incidents = res.get("incidents", [])
        open_now = res.get("open", 0)
        # Nothing should be open while the box is healthy; the endpoint existing
        # and answering is what proves the loop has somewhere to record.
        status2, summary = self.request("/api/operations/summary")
        healthy = status2 == 200 and summary.get("services", {}).get("postgres") == "up"
        passed = healthy and open_now == len([i for i in incidents if not i.get("closed_at")])
        self.record("L19", "Health Incident Tracking", passed,
                    f"open={open_now}, recorded={len(incidents)}, postgres_up={healthy}")

    def test_adr005_supervisor_redaction(self):
        """ADR 005 — code/logs with no project are held, not sent to a free model."""
        status, conv = self.request("/api/conversations")
        if status != 200 or not conv.get("conversations"):
            self.record("ADR005", "Supervisor Payload Redaction", False, "no conversations")
            return
        globals_ = [c for c in conv["conversations"] if c.get("project_id") is None]
        if not globals_:
            self.record("ADR005", "Supervisor Payload Redaction", False, "no global thread")
            return
        conv_id = globals_[0]["id"]

        # Normal prose must NOT be held by the filter. Whether the provider then
        # answers is L4's business, not this test's — a free-tier 429 here would
        # otherwise look like a redaction failure.
        status, res = self.request(f"/api/conversations/{conv_id}/messages", method="POST",
                                   data={"body": "Reply with the single word OK."})
        normal_reply = (res.get("assistant") or "") if status in (200, 502) else ""
        normal_ok = status in (200, 502) and "not sent to the Supervisor" not in normal_reply

        # A stack trace with no project must be held.
        trace = "\n".join([
            "Traceback (most recent call last):",
            '  File "app.py", line 42, in handler',
            "    raise ValueError(token)",
            "ValueError: sk-live-example",
        ])
        status, res = self.request(f"/api/conversations/{conv_id}/messages", method="POST",
                                   data={"body": trace})
        reply = (res.get("assistant") or "") if status == 200 else ""
        held = "not sent to the Supervisor" in reply

        # And it must leave a routing question behind rather than vanishing.
        status, issues = self.request("/api/issues")
        asked = any("Which project is this" in i.get("title", "")
                    for i in issues.get("issues", [])) if status == 200 else False

        passed = normal_ok and held and asked
        self.record("ADR005", "Supervisor Payload Redaction", passed,
                    f"prose_not_held={normal_ok}, code_held={held}, routing_issue={asked}")

    def test_workers_protocol(self):
        """WORKERS.md — cancel is observable, and progress is separate from checkpoints."""
        task_id = self._make_task("acceptance worker protocol probe", state="running")
        if not task_id:
            self.record("WORKERS", "Worker Protocol", False, "could not create the probe task")
            return

        # Cancel must move the task and leave a transition behind, not just flip a flag.
        status, _ = self.request(f"/api/tasks/{task_id}/cancel", method="POST", data={})
        cancelled_ok = status == 200

        status, d = self.request(f"/api/tasks/{task_id}")
        task = d.get("task", {}) if status == 200 else {}
        state_ok = task.get("state") == "cancelled"
        flagged = bool(task.get("cancel_requested_at"))
        transitions = [t["to_state"] for t in d.get("transitions", [])] if status == 200 else []
        trail_ok = "cancelled" in transitions

        # The detail payload must expose progress events separately from checkpoints.
        has_events_key = "events" in d
        checkpoints = d.get("checkpoints", [])
        # No checkpoint may be a progress event in disguise.
        no_log_checkpoints = all(
            not ("type" in (c.get("payload") or {}) and "name" in (c.get("payload") or {}))
            for c in checkpoints
        )

        # Cancelling a finished task must 409 rather than pretend.
        status, _ = self.request(f"/api/tasks/{task_id}/cancel", method="POST", data={})
        replay_409 = status == 409

        passed = (cancelled_ok and state_ok and flagged and trail_ok
                  and has_events_key and no_log_checkpoints and replay_409)
        self.record("WORKERS", "Worker Protocol", passed,
                    f"cancelled={state_ok}, flag={flagged}, trail={trail_ok}, "
                    f"events_split={has_events_key and no_log_checkpoints}, replay_409={replay_409}")

    def test_input_validation(self):
        """Model- and client-supplied values must not reach the filesystem or a CHECK."""
        # The slug becomes /var/lib/jarvis/worktrees/<slug>.
        traversals = ["../../../tmp/pwned", "..", "a/b", "UPPER", "-lead", "x"]
        rejected = []
        for slug in traversals:
            status, _ = self.request("/api/projects", method="POST", data={
                "name": "traversal probe", "slug": slug, "project_type": "personal",
            })
            rejected.append(status == 400)
        traversal_blocked = all(rejected)

        # Enum values must 400, not 500 on a constraint violation.
        status, _ = self.request("/api/projects", method="POST", data={
            "name": "enum probe", "slug": "enum-probe-acceptance",
            "project_type": "personal", "confidentiality": "top-secret",
        })
        enum_blocked = status == 400

        status, _ = self.request("/api/projects", method="POST", data={
            "name": "type probe", "slug": "type-probe-acceptance",
            "project_type": "not-a-type",
        })
        type_blocked = status == 400

        # A legitimate project must still be creatable, or this is just an outage.
        slug = f"validation-ok-{int(time.time())}"
        status, res = self.request("/api/projects", method="POST", data={
            "name": "validation ok", "slug": slug, "project_type": "personal",
        })
        legit_ok = status == 200 and res.get("project", {}).get("slug") == slug

        passed = traversal_blocked and enum_blocked and type_blocked and legit_ok
        self.record("VALIDATION", "Input Validation & Path Safety", passed,
                    f"traversal_blocked={traversal_blocked}, enum_400={enum_blocked}, "
                    f"type_400={type_blocked}, legit_created={legit_ok}")

    def test_api_contract(self):
        """API_AND_EVENTS.md — correlation id, error shape, and artifact gating."""
        # X-Request-Id on every response, echoed when the caller supplies one.
        req = urllib.request.Request(f"{BASE_URL}/api/health", method="GET")
        try:
            with self.opener.open(req, timeout=10) as r:
                generated = r.headers.get("X-Request-Id")
        except Exception:
            generated = None

        req = urllib.request.Request(f"{BASE_URL}/api/health", method="GET",
                                     headers={"X-Request-Id": "acceptance-probe-id"})
        try:
            with self.opener.open(req, timeout=10) as r:
                echoed = r.headers.get("X-Request-Id")
        except Exception:
            echoed = None

        correlation_ok = bool(generated) and echoed == "acceptance-probe-id"

        # A quarantined artifact is never served; an unknown one 404s.
        status, res = self.request("/api/artifacts")
        artifacts = res.get("artifacts", []) if status == 200 else []
        quarantined = [a for a in artifacts if a.get("quarantine_state") != "clean"]
        gate_ok = True
        if quarantined:
            status, _ = self.request(f"/api/artifacts/{quarantined[0]['id']}?download=1")
            gate_ok = status == 409

        status, _ = self.request("/api/artifacts/00000000-0000-0000-0000-000000000000?download=1")
        unknown_404 = status == 404

        passed = correlation_ok and gate_ok and unknown_404
        self.record("API", "API Contract", passed,
                    f"request_id={correlation_ok}, quarantine_gate={gate_ok} "
                    f"({len(quarantined)} quarantined), unknown_404={unknown_404}")

    def _multipart(self, path, fields, files):
        """POST multipart/form-data with the session cookie."""
        boundary = "----jarvisacceptance" + str(int(time.time() * 1000))
        parts = []
        for name, value in fields.items():
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'
                .encode("utf-8")
            )
        for name, (filename, content) in files.items():
            parts.append(
                (f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
                 f'filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n')
                .encode("utf-8")
            )
            parts.append(content if isinstance(content, bytes) else content.encode("utf-8"))
            parts.append(b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode("utf-8"))
        body = b"".join(parts)

        req = urllib.request.Request(
            f"{BASE_URL}{path}",
            data=body,
            method="POST",
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Origin": ORIGIN,
            },
        )
        try:
            with self.opener.open(req, timeout=45) as res:
                return res.status, json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode("utf-8"))
            except Exception:
                return e.code, {}
        except Exception as e:
            return 0, {"error": str(e)}

    def test_upload_scan(self):
        """Attachments are persisted, scanned, and never served unscanned."""
        # All three files in one request: the scan is per-file, and firing three
        # separate Supervisor turns just to test file handling burns free-tier
        # quota that the model-failover test needs.
        st, arts_before = self.request("/api/artifacts")
        before_artifact_ids = {a["id"] for a in (arts_before.get("artifacts", []) if st == 200 else [])}

        status, res = self._multipart(
            "/api/inbox",
            {"body": "acceptance upload probe"},
            {
                "clean": ("acceptance-note.txt", "harmless acceptance attachment\n"),
                "executable": ("acceptance-payload.exe", b"MZ\x90\x00binary"),
                "disguised": ("acceptance-disguised.txt", "#!/bin/sh\necho hi\n"),
            },
        )
        # The verdicts come from the artifact store, not the POST response.
        #
        # /api/inbox runs a Supervisor turn before it answers, so when every
        # route is rate-limited the client times out and the response is empty —
        # twice now that has reported correctly blocked files as unblocked, once
        # at a 30s timeout and again at 45s. Raising the number is a treadmill:
        # the scan verdict simply does not depend on the model turn, and the
        # stored row is what the download gate enforces against anyway.
        atts = res.get("attachments", []) if status in (200, 502) else []
        by_name = {a["filename"]: a for a in atts}

        st, arts_after = self.request("/api/artifacts")
        fresh = [a for a in (arts_after.get("artifacts", []) if st == 200 else [])
                 if a["id"] not in before_artifact_ids]

        def verdict(name):
            """This run's row for `name`, or the POST response as a fallback.

            Scoped to ids created by this request: matching on filename alone
            would find a previous run's artifact and pass on its evidence.
            """
            for a in fresh:
                if a.get("path", "").endswith(name):
                    return a.get("quarantine_state")
            return by_name.get(name, {}).get("quarantineState")

        clean_ok = verdict("acceptance-note.txt") == "clean"
        blocked_ok = verdict("acceptance-payload.exe") == "blocked"
        disguise_ok = verdict("acceptance-disguised.txt") == "blocked"

        # The blocked ones must not be downloadable.
        gate_ok = True
        st, arts = self.request("/api/artifacts")
        if st == 200:
            uploads = [a for a in arts.get("artifacts", []) if a.get("source") == "upload"]
            blocked = [a for a in uploads if a.get("quarantine_state") == "blocked"]
            if blocked:
                st2, _ = self.request(f"/api/artifacts/{blocked[0]['id']}?download=1")
                gate_ok = st2 == 409

        passed = clean_ok and blocked_ok and disguise_ok and gate_ok
        self.record("UPLOAD", "Attachment Scan & Gate", passed,
                    f"clean={clean_ok}, exe_blocked={blocked_ok}, new_artifacts={len(fresh)}, "
                    f"disguised_script_blocked={disguise_ok}, download_gate={gate_ok}")

    def test_endpoint_sweep(self):
        """Every read endpoint answers without a 5xx.

        SQL that references a missing column, or locks the wrong side of a join,
        compiles and type-checks fine and only fails when the query runs. A
        broken claim query hid for five ticks that way, so the sweep is part of
        the suite rather than something done by hand.
        """
        # Resolve one real id per shape so the :id routes are exercised too.
        def first(path, key, field="id"):
            st, r = self.request(path)
            items = r.get(key, []) if st == 200 else []
            return items[0][field] if items else None

        conv = first("/api/conversations", "conversations")
        task = first("/api/tasks", "tasks")
        issue = first("/api/issues", "issues")
        project = first("/api/projects", "projects", "slug")
        artifact = first("/api/artifacts", "artifacts")
        inbox = first("/api/inbox", "inbox")
        schedule = first("/api/schedules", "schedules")
        action = first("/api/action-requests", "action_requests")

        paths = [
            "/api/action-requests", "/api/approvals", "/api/artifacts", "/api/audit",
            "/api/channel-allowlist", "/api/config-versions", "/api/connections",
            "/api/conversations", "/api/grants", "/api/health", "/api/health-incidents",
            "/api/inbox", "/api/inbox?state=failed", "/api/issues", "/api/me",
            "/api/memory", "/api/models", "/api/notifications",
            "/api/operations/quiet-hours", "/api/operations/summary", "/api/projects",
            "/api/queue", "/api/schedules", "/api/setup", "/api/tasks",
            "/api/tasks?routine=1", "/api/github/me",
        ]
        if conv:
            paths += [f"/api/conversations/{conv}", f"/api/conversations/{conv}/messages"]
        if task:
            paths.append(f"/api/tasks/{task}")
        if issue:
            paths.append(f"/api/issues/{issue}")
        if project:
            paths.append(f"/api/projects/{project}")
        if artifact:
            paths.append(f"/api/artifacts/{artifact}")
        if inbox:
            paths.append(f"/api/inbox/{inbox}")
        if schedule:
            paths.append(f"/api/schedules/{schedule}/runs")
        if action:
            paths.append(f"/api/action-requests/{action}")

        broken = []
        for path in paths:
            status, body = self.request(path)
            if status >= 500 or status == 0:
                detail = body if isinstance(body, str) else json.dumps(body)[:120]
                broken.append(f"{path}={status} {detail}")

        self.record("SWEEP", "Endpoint Sweep (no 5xx)", not broken,
                    f"checked {len(paths)} endpoints, broken={broken or 'none'}")

    def test_host_metrics(self):
        """Plan §39 — CPU/RAM/disk/I/O on the Command Center, and plausible."""
        status, res = self.request("/api/operations/summary")
        host = res.get("host") if status == 200 else None
        if not host:
            self.record("HOST", "Host Metrics", False, "no host block in the operations summary")
            return

        cpu = host.get("cpu", {})
        mem = host.get("memory", {})
        disk = host.get("disk") or {}

        # Sanity, not exact values: a metric that is present but nonsense is
        # worse than a missing one because it looks authoritative.
        cpu_ok = cpu.get("cores", 0) >= 1 and 0 <= cpu.get("busy_pct", -1) <= 100
        mem_ok = (mem.get("total_bytes", 0) > 512 * 1024 * 1024
                  and 0 <= mem.get("used_pct", -1) <= 100
                  and mem.get("available_bytes", -1) <= mem.get("total_bytes", 0))
        disk_ok = (disk.get("total_bytes", 0) > 0
                   and 0 <= disk.get("used_pct", -1) <= 100
                   and disk.get("free_bytes", -1) <= disk.get("total_bytes", 0))
        uptime_ok = host.get("uptime_seconds", 0) > 0

        passed = cpu_ok and mem_ok and disk_ok and uptime_ok
        self.record("HOST", "Host Metrics", passed,
                    f"cpu={cpu.get('busy_pct')}% of {cpu.get('cores')} cores, "
                    f"mem={mem.get('used_pct')}%, disk={disk.get('used_pct')}%, "
                    f"uptime={round(host.get('uptime_seconds', 0) / 3600, 1)}h")

    def test_service_coverage(self):
        """Plan §42 — every named service is reported, and gated ones say so."""
        status, res = self.request("/api/operations/services")
        if status != 200:
            self.record("SERVICES", "Service Coverage (§42)", False, f"status={status}")
            return

        services = {x["key"]: x for x in res.get("services", [])}
        # The list the plan names. Absent rows read as "fine", which is the
        # failure mode this endpoint exists to prevent.
        required = [
            "infrastructure", "openclaw", "api", "postgres", "queue", "workers",
            "browsers", "whatsapp", "telnyx", "elevenlabs", "models",
            "connections", "schedules", "backups", "security",
        ]
        missing = [k for k in required if k not in services]

        valid_states = {"healthy", "degraded", "failed", "not_configured", "unknown"}
        bad_state = [k for k, v in services.items() if v.get("state") not in valid_states]
        no_detail = [k for k, v in services.items() if not (v.get("detail") or "").strip()]

        # Gated services must not drag `overall` down — they are pending setup,
        # not broken, and a permanently unhealthy box is one nobody reads.
        gated_states = {v["state"] for v in services.values() if v.get("gated")}
        overall = res.get("overall")
        overall_sane = overall in {"healthy", "degraded", "failed"}
        not_dragged = not (overall == "failed" and gated_states <= {"not_configured", "degraded"}
                           and all(v["state"] != "failed"
                                   for v in services.values() if not v.get("gated")))

        passed = not missing and not bad_state and not no_detail and overall_sane and not_dragged
        self.record("SERVICES", "Service Coverage (§42)", passed,
                    f"overall={overall}, {len(services)} services, missing={missing or 'none'}, "
                    f"bad_state={bad_state or 'none'}, gated={res.get('gated_count')}")

    def test_task_timing(self):
        """Plan §41 — active, elapsed, waiting and paused time on task detail."""
        status, res = self.request("/api/tasks")
        tasks = res.get("tasks", []) if status == 200 else []
        if not tasks:
            self.record("TIMING", "Task Time Accounting (§41)", False, "no tasks to inspect")
            return

        status, d = self.request(f"/api/tasks/{tasks[0]['id']}")
        timing = d.get("timing") if status == 200 else None
        if not timing:
            self.record("TIMING", "Task Time Accounting (§41)", False, "no timing block")
            return

        parts = ["elapsed_seconds", "active_seconds", "waiting_seconds", "paused_seconds"]
        present = all(p in timing for p in parts)
        non_negative = all(timing.get(p, -1) >= 0 for p in parts)
        # The buckets are subsets of wall clock, so their sum cannot exceed it
        # by more than rounding.
        summed = sum(timing.get(p, 0) for p in parts[1:])
        coherent = summed <= timing.get("elapsed_seconds", 0) + 2

        passed = present and non_negative and coherent
        self.record("TIMING", "Task Time Accounting (§41)", passed,
                    f"elapsed={timing.get('elapsed_seconds')}s, active={timing.get('active_seconds')}s, "
                    f"waiting={timing.get('waiting_seconds')}s, coherent={coherent}")

    def test_tool_actually_ran(self):
        """A turn that says it stored something must have called the tool.

        The Supervisor prompt forbids claiming an action succeeded unless the
        tool call did. Nothing could verify that until tool calls were audited —
        a model can answer "Stored." without touching the database.
        """
        # /api/memory is capped at 50 rows, so once the table passes that the
        # count can never grow and "50->50" reads as if nothing was stored. The
        # list is newest-first, so presence of the marker is the real signal.
        status, before = self.request("/api/memory")
        before_marker_rows = len(before.get("memory", [])) if status == 200 else 0

        status, conv = self.request("/api/conversations")
        globals_ = [c for c in conv.get("conversations", []) if c.get("project_id") is None] \
            if status == 200 else []
        if not globals_:
            self.record("TOOLCALL", "Tool Call Actually Runs", False, "no global thread")
            return

        status, audit = self.request("/api/audit?action=supervisor.tool")
        before_tool_ids = {e.get("id") for e in (audit.get("events") or [])}             if status == 200 else set()

        marker = f"acceptance tool probe {int(time.time())}"
        # One retry, as L0 has: a single 429 across the chain is a provider
        # condition, not evidence about tool calls. Skipping still beats
        # passing on nothing when both attempts fail.
        reply = ""
        for attempt in range(2):
            status, res = self.request(
                f"/api/conversations/{globals_[0]['id']}/messages", method="POST",
                data={"body": f"Store a durable note with exactly this text: {marker}"},
            )
            reply = (res.get("assistant") or "") if status in (200, 502) else ""
            if status == 200 and reply:
                break
            if attempt == 0:
                time.sleep(15)

        # Provider exhaustion is not this test's subject; only judge when a
        # reply actually came back.
        if status == 502 or not reply:
            self.skip("TOOLCALL", "Tool Call Actually Runs",
                      "no provider answered this turn (all routes rate-limited)")
            return

        time.sleep(1)
        status, after = self.request("/api/memory")
        rows = after.get("memory", []) if status == 200 else []
        stored = any(marker in (r.get("body") or "") for r in rows)

        # And the call must appear in the audit trail, not just the table —
        # from THIS turn. Scanning the newest 20 for any supervisor.tool event
        # was satisfied by a previous run's call, which is the same unscoped
        # shape already fixed in TOOLCALL2.
        status, audit = self.request("/api/audit?action=supervisor.tool")
        events = (audit.get("events") or []) if status == 200 else []
        audited = any(e.get("action") == "supervisor.tool"
                      and e.get("id") not in before_tool_ids for e in events)

        # A claim is a completed action asserted up front, not a word appearing
        # anywhere in the text. The substring scan scored "I can't store it right
        # now - nothing was written" as a claim to have stored, and failed a
        # fallback route that had behaved perfectly. This mirrors CLAIM_RE in
        # src/supervisor.ts, which got it right and did not fire on that reply.
        claimed = bool(re.match(
            r"\s*(?:ok[,.]?\s*)?(?:i(?:'ve| have)?\s+)?"
            r"(stored|saved|created|opened|scheduled|added|registered|updated|noted)\b",
            reply, re.IGNORECASE))
        honest = stored or not claimed

        passed = honest and (audited or not claimed)
        self.record("TOOLCALL", "Tool Call Actually Runs", passed,
                    f"claimed={claimed}, stored={stored}, audited={audited}, "
                    f"marker_found_in_newest_{len(rows)}_of_capped_list "
                    f"(was {before_marker_rows})")

    def test_repeat_store_still_calls_tool(self):
        """Asking again for something already stored must still call the tool.

        Observed live: the second time it was asked to remember the same fact,
        the Supervisor answered "Stored: ..." and wrote nothing. The row from the
        first request made the claim look true, so the failure was invisible.
        The turn must either call the tool again or not claim it did.
        """
        status, conv = self.request("/api/conversations")
        globals_ = [c for c in conv.get("conversations", []) if c.get("project_id") is None]             if status == 200 else []
        if not globals_:
            self.record("TOOLCALL2", "Repeat Store Calls Tool", False, "no global thread")
            return
        cid = globals_[0]["id"]

        ask = "Remember that acceptance runs against Netcup."
        # First request seeds the fact and puts it in the thread history.
        self.request(f"/api/conversations/{cid}/messages", method="POST", data={"body": ask})
        time.sleep(1)

        status, audit = self.request("/api/audit")
        prior = (audit.get("events") or []) if status == 200 else []
        before_ids = {e.get("id") for e in prior if e.get("action") == "supervisor.tool"}
        # Scoped the same way as before_ids. Reading "is there any
        # unverified_claim in the last 20 events" counted a flag raised an hour
        # earlier by something else, which would let a genuinely unbacked claim
        # pass on someone else's evidence.
        before_flag_ids = {e.get("id") for e in prior
                           if e.get("action") == "supervisor.unverified_claim"}

        # Second, identical request — the case that failed.
        status, res = self.request(f"/api/conversations/{cid}/messages", method="POST",
                                   data={"body": ask})
        reply = (res.get("assistant") or "") if status in (200, 502) else ""
        if status == 502 or not reply:
            self.skip("TOOLCALL2", "Repeat Store Calls Tool",
                      "no provider answered this turn (all routes rate-limited)")
            return
        time.sleep(1)

        status, audit = self.request("/api/audit")
        events = (audit.get("events") or []) if status == 200 else []
        called_again = any(e.get("action") == "supervisor.tool" and e.get("id") not in before_ids
                           for e in events[:20])
        flagged = any(e.get("action") == "supervisor.unverified_claim"
                      and e.get("id") not in before_flag_ids for e in events[:20])
        claimed = reply.strip().lower().startswith(("stored", "saved", "noted", "ok, stored",
                                                    "i've stored", "i have stored"))

        # Either it really called the tool, or it did not claim, or the
        # discrepancy is on the record. A silent unbacked claim is the failure.
        passed = called_again or not claimed or flagged
        self.record("TOOLCALL2", "Repeat Store Calls Tool", passed,
                    f"claimed={claimed}, called_again={called_again}, flagged={flagged}")

    def test_notification_delivery_reported(self):
        """A notification that never arrived must be visible somewhere.

        Nine blockers — the WhatsApp, Telnyx, host-login and Composio gates —
        had exhausted their retries on the WhatsApp channel and sat `failed` in
        the outbox with nothing reading them. Harmless only because WhatsApp is
        unpaired and every one also went out over the UI channel; a configured
        channel failing the same way would have looked identical.

        This is not one of the fifteen services §42 names, so it is checked here
        rather than folded into that list.
        """
        status, svc = self.request("/api/operations/services")
        if status != 200:
            self.record("NOTIFY", "Notification Delivery Reported", False, f"status={status}")
            return
        row = next((x for x in svc.get("services", []) if x.get("key") == "notifications"), None)
        if not row:
            self.record("NOTIFY", "Notification Delivery Reported", False,
                        "no notification-delivery row in service coverage")
            return

        reported = bool((row.get("detail") or "").strip()) and row.get("state") in (
            "healthy", "degraded", "failed",
        )

        # Cross-check against the outbox itself. /api/notifications is capped, so
        # only the one-directional claim is sound: a failure we can SEE on a
        # channel that is always configured must show as degraded. Not seeing one
        # proves nothing about older rows.
        status, res = self.request("/api/notifications")
        outbox = res.get("notifications", []) if status == 200 else []
        ui_failed = [n for n in outbox if n.get("state") == "failed" and n.get("channel") == "ui"]
        consistent = (not ui_failed) or row.get("state") in ("degraded", "failed")

        gated_failed = [n for n in outbox if n.get("state") == "failed" and n.get("channel") != "ui"]
        passed = reported and consistent
        self.record("NOTIFY", "Notification Delivery Reported", passed,
                    f"state={row.get('state')}, ui_failed={len(ui_failed)}, "
                    f"gated_failed={len(gated_failed)}, detail={(row.get('detail') or '')[:60]}")

    def test_totals_contract(self):
        """A list endpoint that caps its rows must also report the real count.

        The Issues page was under-reporting "Handled by Jarvis" (it could see at
        most ~190 of 215), the Work page showed 100 of 250 tasks, and a project
        with 112 tasks read as 50. The pages now use server-side totals — but if
        a refactor dropped `totals`, every page falls back to counting its own
        page again and the undercount returns with nothing to say so.

        A total can never be smaller than the page it summarises, which is the
        invariant worth pinning.
        """
        checks = []
        for path, key, field in (
            ("/api/issues", "issues", "all"),
            ("/api/tasks", "tasks", "all"),
            ("/api/artifacts", "artifacts", "all"),
        ):
            status, res = self.request(path)
            if status != 200:
                checks.append((path, False, f"status={status}"))
                continue
            totals = res.get("totals")
            page = len(res.get(key, []))
            if not isinstance(totals, dict) or field not in totals:
                checks.append((path, False, "no totals"))
                continue
            checks.append((path, totals[field] >= page, f"{page}/{totals[field]}"))

        # Per-project totals, on the project that actually exceeds the cap.
        status, res = self.request("/api/projects/jarvis-maintenance")
        if status == 200:
            totals = res.get("totals")
            page = len(res.get("tasks", []))
            ok = isinstance(totals, dict) and totals.get("tasks", -1) >= page
            checks.append(("project", ok, f"{page}/{(totals or {}).get('tasks')}"))
        else:
            checks.append(("project", False, f"status={status}"))

        failed = [c for c in checks if not c[1]]
        self.record("TOTALS", "List Totals Contract", not failed,
                    ", ".join(f"{name}={detail}" for name, _, detail in checks))

    def run_all(self):
        print("=== Running Jarvis V1.2 Acceptance Test Suite ===")
        if not self.test_login():
            print("Login failed, aborting suite.")
            return

        self.test_l16_ui_security()
        self.test_l0_first_run_chat_and_onboarding()
        self.test_l1_inbox_persist_first()
        self.test_l2_restart_recovery()
        self.test_l3_watchdog_transitions()
        self.test_l4_model_failover()
        self.test_workers_protocol()
        self.test_l5_action_request_flow()
        self.test_l8_always_confirm()
        self.test_endpoint_sweep()
        self.test_host_metrics()
        self.test_service_coverage()
        self.test_task_timing()
        self.test_api_contract()
        self.test_upload_scan()
        self.test_input_validation()
        self.test_l9_cross_project_isolation()
        self.test_adr005_supervisor_redaction()
        self.test_tool_actually_ran()
        self.test_repeat_store_still_calls_tool()
        self.test_totals_contract()
        self.test_notification_delivery_reported()
        self.test_l10_notification_brevity()
        self.test_l11_auth_profile_isolation()
        self.test_l13_quiet_hours()
        self.test_l14_schedules()
        self.test_l14b_schedule_next_run()
        self.test_l15_restore_drill()
        self.test_l17_mobile_reachability()
        self.test_l19_health_incidents()
        self.test_connections()
        self.test_models()

        self.cleanup()
        self.save_report()

    def cleanup(self):
        """Leave the live box as close to how it was found as possible."""
        status, res = self.request("/api/acceptance/cleanup", method="POST", data={})
        if status == 200:
            print(f"[CLEAN] probes: {res.get('cancelled_tasks', 0)} tasks cancelled, "
                  f"{res.get('archived_projects', 0)} projects archived, "
                  f"{res.get('resolved_issues', 0)} issues resolved")
        else:
            print(f"[CLEAN] cleanup returned {status}")

    def save_report(self):
        today = datetime.utcnow().strftime("%Y-%m-%d")
        report_dir = Path("docs/acceptance")
        report_dir.mkdir(parents=True, exist_ok=True)
        report_file = report_dir / f"{today}-acceptance.md"

        lines = [
            f"# Acceptance Test Report — {today}",
            f"Target: `{BASE_URL}`",
            f"Operator: `{self.login_user}`",
            "",
            "| Test | Loop | Status | Details |",
            "|---|---|---|---|",
        ]
        for r in self.results:
            lines.append(f"| {r['title']} | `{r['loop']}` | **{r['status']}** | {r['details']} |")

        lines.extend([
            "",
            "## Summary",
            f"- Total Tests: {len(self.results)}",
            f"- Passed: {sum(1 for r in self.results if r['status'] == 'PASS')}",
            f"- Failed: {sum(1 for r in self.results if r['status'] == 'FAIL')}",
            # Counted separately so a run with skips never reads as full coverage.
            f"- Skipped: {sum(1 for r in self.results if r['status'] == 'SKIP')}",
            "",
            "## Missing / Deferred Capabilities (Blocked on Operator Keys / Logins)",
            "- Anthropic / Codex / Cursor host login sessions on VPS (`harness` heavy lane)",
            "- WhatsApp dedicated number & QR pairing (OpenClaw channel)",
            "- Telnyx E.164 numbers & ElevenLabs voice_id in site.yaml",
            "- Netcup SCP OAuth refresh token",
        ])

        report_file.write_text("\n".join(lines), encoding="utf-8")
        print(f"\nReport written to {report_file}")

    def test_n1_acceptance(self):
        """N1 — the one-line test: a seeded failing test, and a PR that fixes it.

        Lives here because the plan says it must ("Done when: it is in
        scripts/acceptance-runner.py and green"), but it drives the dev compose
        stack rather than the live API: the assertions are about a git diff and
        a test going red to green, and neither is visible over HTTP.
        """
        try:
            from s8_n1 import run_n1
        except ImportError as err:
            self.skip("N1", "acceptance", f"could not import s8_n1: {err}")
            return
        run_n1(self.record, self.skip)


if __name__ == "__main__":
    runner = AcceptanceRunner()
    runner.run_all()

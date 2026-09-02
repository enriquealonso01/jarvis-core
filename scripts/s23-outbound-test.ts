/**
 * S23 — Jarvis calls Enrique.
 *
 * The list of six reasons is the feature. A dialler that rings for anything else
 * is not a more helpful assistant, it is one that gets silenced permanently —
 * and then none of the six work either. So the test that matters most here is
 * the negative one: a routine completion must never ring the phone.
 *
 * And the override, in the plan's own words: "A security incident at 02:00 →
 * rings. A production outage at 02:00 → does not. That pair is the whole
 * override, and testing only the first half proves nothing."
 */
import { createPool } from "../src/db.js";
import {
  CALL_REASONS, clearDialled, dialled, mayDial, nextMorning, openingLine,
  placeCall, reasonsToCall, sweepOutboundCalls, wantCall, type CallReason,
} from "../src/outbound.js";

const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 240)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));

const STAMP = Date.now().toString(36).slice(-6);

/** A local wall-clock time in New York, as an instant. */
function nyc(dateIso: string): Date {
  // EDT in September is UTC-4; the assertions below are all inside that window.
  return new Date(`${dateIso}-04:00`);
}

async function clean(): Promise<void> {
  await pool.query("DELETE FROM outbound_calls WHERE subject LIKE $1", [`%${STAMP}%`]);
  await pool.query("DELETE FROM issues WHERE title LIKE $1", [`%${STAMP}%`]);
  await pool.query("DELETE FROM schedules WHERE name LIKE $1", [`%${STAMP}%`]);
}

/**
 * The second pass: a `site.yaml` with no `telnyx` block at all.
 *
 * It is a separate process rather than another block below because
 * `JARVIS_SITE_YAML` is read at import time and the file cannot be swapped
 * mid-run. It earns the extra invocation: an unpinned sender is precisely the
 * production state that produced `422 10004 Missing required parameter /from`,
 * and the only way to be sure Jarvis now refuses instead of dialling into the
 * void is to take the pin away and watch it refuse.
 */
async function noTelnyxPass(): Promise<void> {
  await clean();
  clearDialled();
  console.log("########## no telnyx pair pinned: refuse, do not dial blank ##########\n");

  const { id } = await wantCall(pool, {
    reason: "blocked_task",
    subject: `something is blocked ${STAMP}`,
    now: nyc("2026-09-02T14:00:00"),
  });
  const attempt = await placeCall(pool, id);
  check("the dial is refused", false, attempt.placed);
  truthy("naming the missing pin", attempt.detail.includes("from_e164"));
  check("and nothing was dialled", 0, dialled.length);

  const row = await pool.query<{ state: string; attempts: number }>(
    "SELECT state, attempts FROM outbound_calls WHERE id = $1", [id]);
  truthy("the call is not recorded as placed", row.rows[0]?.state !== "placed");
  check("and the attempt is not spent, so a fix can retry", 0, row.rows[0]?.attempts);

  await clean();
}

async function main(): Promise<void> {
  if (process.env.JARVIS_S23_NO_TELNYX === "1") {
    await noTelnyxPass();
    console.log(`\n==== ${pass} passed, ${fail} failed ====`);
    return;
  }

  await clean();
  clearDialled();

  console.log("########## quiet hours, enforced at the dial site ##########\n");
  {
    const workday = nyc("2026-09-02T14:00:00");
    const evening = nyc("2026-09-02T20:00:00");
    const night = nyc("2026-09-03T02:00:00");
    const saturday = nyc("2026-09-05T10:00:00");
    const edge = nyc("2026-09-02T19:29:00");
    const justAfter = nyc("2026-09-02T19:31:00");

    check("a blocked task rings during the day", true, mayDial("blocked_task", workday).ring);
    check("and not at 20:00", false, mayDial("blocked_task", evening).ring);
    check("19:29 is still the day", true, mayDial("blocked_task", edge).ring);
    check("19:31 is not", false, mayDial("blocked_task", justAfter).ring);
    check("Saturday at 10:00 is fine — weekends are not quiet", true, mayDial("blocked_task", saturday).ring);

    /*
     * The whole override, both halves. Testing only the first proves nothing.
     */
    check("a SECURITY event at 02:00 rings", true, mayDial("security_event", night).ring);
    check("a production outage at 02:00 does NOT", false, mayDial("production_incident", night).ring);
    check("nor does an overdue approval", false, mayDial("approval_overdue", night).ring);
    check("nor a blocked task", false, mayDial("blocked_task", night).ring);
    check("nor a call he scheduled", false, mayDial("scheduled", night).ring);
    check("nor a monitor", false, mayDial("monitor", night).ring);
    ok("...one exception, short enough to read aloud");

    const blocked = mayDial("blocked_task", evening);
    if (!blocked.ring) {
      const at = blocked.retryAfter;
      truthy("a blocked call comes back in the morning", at);
      const hour = at
        ? Number(new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23",
          }).format(at))
        : -1;
      check("at 08:00", 8, hour);
      truthy("which is later than the moment it was refused", (at?.getTime() ?? 0) > evening.getTime());
    }
    const fromNight = nextMorning(nyc("2026-09-03T02:00:00"));
    check("and a 02:00 refusal waits only until that same morning", 8,
      Number(new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23",
      }).format(fromNight)));
  }

  console.log("\n########## it says who it is and why, first ##########\n");
  {
    const line = openingLine("blocked_task", `The Alpha migration is waiting on you ${STAMP}`);
    truthy("it names itself", line.startsWith("This is Jarvis"));
    truthy("and the reason, in the first sentence", line.split(".")[0].includes("blocked on you"));
    truthy("before the subject", line.indexOf("blocked on you") < line.indexOf(STAMP));
  }

  console.log("\n########## the six reasons, and only those ##########\n");
  {
    const project = await pool.query<{ id: string }>(
      "SELECT id FROM projects WHERE slug = 'dev-sandbox'");
    const pid = project.rows[0].id;

    // A routine completion. This is the one that must NOT ring.
    const done = await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, objective, state, lane, priority)
       VALUES ($1, 'routine completion ${STAMP}', 'x', 'succeeded', 'heavy', 'normal') RETURNING id`,
      [pid],
    );
    await pool.query(
      `INSERT INTO issues (severity, category, service, status, owner, title, dedupe_key)
       VALUES ('medium','config.drift','worker','open','jarvis','a medium issue ${STAMP}','routine.${STAMP}')`,
    );

    let wanted = await reasonsToCall(pool);
    const mine = wanted.filter((w) => w.subject.includes(STAMP));
    check("a finished task and a medium issue ring nothing", 0, mine.length);
    ok("...which is the assertion the plan cares about most");

    // 1. a task blocked over an hour
    const blocked = await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, objective, state, lane, priority, waiting_reason, updated_at)
       VALUES ($1, 'blocked task ${STAMP}', 'x', 'waiting_for_user', 'heavy', 'normal',
               'needs your GitHub token', now() - interval '2 hours') RETURNING id`,
      [pid],
    );
    // ...and one blocked for only ten minutes, which must NOT ring yet.
    await pool.query(
      `INSERT INTO tasks (project_id, title, objective, state, lane, priority, updated_at)
       VALUES ($1, 'recently blocked ${STAMP}', 'x', 'waiting_for_user', 'heavy', 'normal',
               now() - interval '10 minutes')`,
      [pid],
    );

    wanted = await reasonsToCall(pool);
    const blockedCalls = wanted.filter((w) => w.reason === "blocked_task" && w.subject.includes(STAMP));
    check("a task blocked over an hour is a reason", 1, blockedCalls.length);
    truthy("naming the task", blockedCalls[0]?.subject.includes("blocked task"));
    truthy("and what it is waiting for", blockedCalls[0]?.subject.includes("GitHub token"));
    check("one blocked for ten minutes is not", 0,
      wanted.filter((w) => w.subject.includes("recently blocked")).length);

    // 4. a security event
    await pool.query(
      `INSERT INTO issues (severity, category, service, status, owner, title, dedupe_key)
       VALUES ('critical','security.isolation','broker','open','jarvis',
               'cross-project read ${STAMP}','sec.${STAMP}')`,
    );
    // 6. a monitor that was explicitly authorised
    await pool.query(
      `INSERT INTO issues (severity, category, service, status, owner, title, dedupe_key, evidence)
       VALUES ('medium','config.drift','monitor','open','jarvis',
               'the disk is filling ${STAMP}','mon.${STAMP}', '{"may_call": "true"}'::jsonb)`,
    );
    // ...and one that was not.
    await pool.query(
      `INSERT INTO issues (severity, category, service, status, owner, title, dedupe_key)
       VALUES ('medium','config.drift','monitor','open','jarvis',
               'a monitor nobody authorised ${STAMP}','mon2.${STAMP}')`,
    );

    wanted = await reasonsToCall(pool);
    check("a security event is a reason", 1,
      wanted.filter((w) => w.reason === "security_event" && w.subject.includes(STAMP)).length);
    check("an authorised monitor is a reason", 1,
      wanted.filter((w) => w.reason === "monitor" && w.subject.includes("disk is filling")).length);
    check("an unauthorised one is not — opt-in, per rule", 0,
      wanted.filter((w) => w.subject.includes("nobody authorised")).length);

    // 5. a call he scheduled, for this very minute
    const now = new Date();
    const cron = `${now.getUTCMinutes()} ${now.getUTCHours()} * * *`;
    await pool.query(
      `INSERT INTO schedules (project_id, name, cron, timezone, action, call_subject)
       VALUES ($1, 'morning call ${STAMP}', $2, 'UTC', 'call',
               'to go over the Alpha migration ${STAMP}')`,
      [pid, cron],
    );
    wanted = await reasonsToCall(pool, now);
    const sched = wanted.filter((w) => w.reason === "scheduled" && w.subject.includes(STAMP));
    check("a call he scheduled is a reason", 1, sched.length);
    truthy("with its subject prepared in advance", sched[0]?.subject.includes("Alpha migration"));

    // Every reason found is one of the six, by name.
    const names = new Set(Object.keys(CALL_REASONS));
    check("and every reason is one of the six", 0,
      wanted.filter((w) => !names.has(w.reason)).length);

    void done;
    void blocked;
  }

  console.log("\n########## it rings, once, and does not redial ##########\n");
  {
    clearDialled();
    const { id, verdict } = await wantCall(pool, {
      reason: "blocked_task",
      subject: `something is blocked ${STAMP}`,
      now: nyc("2026-09-02T14:00:00"),
    });
    check("the decision is to ring", true, verdict.ring);
    const first = await placeCall(pool, id);
    check("and it rings", true, first.placed);
    check("once", 1, dialled.length);
    truthy("saying who and why", dialled[0]?.subject.startsWith("This is Jarvis"));

    /*
     * Which numbers. A voice call is dialled on the Telnyx pair; this read the
     * WhatsApp pair instead, and because `whatsapp.jarvis_e164` is blank in
     * production the first real dial came back
     * `422 10004 Missing required parameter /from`. The fixture gives all four
     * numbers different values so these two assertions can only pass for the
     * right reason.
     */
    check("it dials FROM the telnyx number", "+15557770001", dialled[0]?.from);
    check("and TO the telnyx number", "+15557770002", dialled[0]?.to);

    const again = await placeCall(pool, id);
    check("a second attempt is refused", false, again.placed);
    truthy("in as many words", again.detail.includes("does not redial"));
    check("and nothing new was dialled", 1, dialled.length);
  }

  console.log("\n########## refused at 20:00: WhatsApp, an issue, and 08:00 ##########\n");
  {
    clearDialled();
    const evening = nyc("2026-09-02T20:00:00");
    const before = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM notifications_outbox");
    const notes = await sweepOutboundCalls(pool, evening);
    console.log(`  ${notes.length} decisions at 20:00`);
    /*
     * The security event DOES ring at 20:00 — that is the override, working. So
     * the assertion is not "nothing rang", which would be asserting the
     * override away; it is that nothing rang EXCEPT that.
     */
    console.log(`  rang: ${dialled.map((d) => d.reason).join(", ") || "(nothing)"}`);
    check("the only thing that rings at 20:00 is a security event", 0,
      dialled.filter((d) => d.reason !== "security_event").length);

    const row = await pool.query<{ state: string; blocked_reason: string; retry_after: Date | null }>(
      `SELECT state, blocked_reason, retry_after FROM outbound_calls
       WHERE subject LIKE $1 AND state = 'blocked' ORDER BY wanted_at DESC LIMIT 1`,
      [`%${STAMP}%`],
    );
    truthy("the call is recorded as blocked", row.rows[0]);
    truthy("with quiet hours as the reason", row.rows[0]?.blocked_reason.includes("quiet hours"));
    truthy("and a time to come back", row.rows[0]?.retry_after);

    const after = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM notifications_outbox");
    truthy("a WhatsApp went out instead", Number(after.rows[0].n) > Number(before.rows[0].n));
    const issue = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM issues WHERE dedupe_key LIKE 'call.fallback:%'");
    truthy("and an issue was raised", Number(issue.rows[0].n) > 0);
  }

  console.log("\n########## the morning retry ##########\n");
  {
    clearDialled();
    await pool.query(
      `UPDATE outbound_calls SET retry_after = now() - interval '1 minute'
       WHERE state = 'blocked' AND subject LIKE $1`,
      [`%${STAMP}%`],
    );
    const morning = nyc("2026-09-03T09:00:00");
    const notes = await sweepOutboundCalls(pool, morning);
    truthy("the calls quiet hours held come back", notes.some((n) => n.includes("retried at 08:00")));
    truthy("and they ring", dialled.length > 0);
    ok(`...${dialled.length} of them, in the morning rather than at 20:00`);
  }

  console.log("\n########## a declined call gets one WhatsApp, no redial ##########\n");
  {
    const { fallBackToWhatsApp } = await import("../src/outbound.js");
    const { id } = await wantCall(pool, {
      reason: "production_incident",
      subject: `the checkout is down ${STAMP}`,
      now: nyc("2026-09-02T14:00:00"),
    });
    clearDialled();
    await placeCall(pool, id);
    check("it rang", 1, dialled.length);
    await pool.query("UPDATE outbound_calls SET state = 'declined', ended_at = now() WHERE id = $1", [id]);
    await fallBackToWhatsApp(pool, id, "you declined it");

    /*
     * One WhatsApp — counted as WhatsApp rows, because the outbox fans a single
     * notification out to the channels it goes to, and the console copy is not
     * a second message to Enrique.
     */
    const notes = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notifications_outbox
       WHERE object_id = $1 AND channel = 'whatsapp'`,
      [id],
    );
    check("one WhatsApp", "1", notes.rows[0].n);

    clearDialled();
    const redial = await placeCall(pool, id);
    check("and no redial", false, redial.placed);
    check("nothing was dialled", 0, dialled.length);
  }

  console.log("\n########## every decision is written down ##########\n");
  {
    const decisions = await pool.query<{ outcome: string; n: string }>(
      `SELECT metadata->>'outcome' AS outcome, count(*)::text AS n
       FROM audit_events WHERE action = 'call.decide'
         AND metadata->>'subject' LIKE $1 GROUP BY 1`,
      [`%${STAMP}%`],
    );
    const allowed = decisions.rows.find((r) => r.outcome === "allowed");
    const denied = decisions.rows.find((r) => r.outcome === "denied");
    truthy("the calls it made are audited", allowed && Number(allowed.n) > 0);
    truthy("and so are the ones it decided against", denied && Number(denied.n) > 0);
    ok("...which is what makes 'is it calling too often' answerable at all");
  }

  await clean();
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

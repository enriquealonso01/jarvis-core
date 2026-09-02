/**
 * S23's third half, unattended: "and stays silent at 21:00."
 *
 * The other two halves were observed by ringing Enrique. This one cannot be —
 * the whole point is that nothing happens, and nobody can sit up all night
 * watching a phone not ring. But every claim in it is a row in the database, so
 * it does not need watching: it needs arming, and then reading in the morning.
 *
 * The timing trick is the whole design. `reasonsToCall` only considers a task
 * that has been `waiting_for_user` for more than an hour, so a task whose
 * `updated_at` is set to 18:45 ET becomes eligible at 19:45 ET — fifteen minutes
 * INSIDE quiet hours — and is invisible to every sweep before that. No cron, no
 * daemon, no long-lived process that might die at 03:00 and take the evidence
 * with it. Arm it in the afternoon and the system does the rest.
 *
 *   arm     create the blocked task, dated so it comes due at 19:45 ET
 *   verify  read what happened; safe to run at any hour, reports what it can see
 *
 * What CANNOT be observed here, and is not claimed: the WhatsApp fallback leg.
 * WhatsApp is not paired (S37), so `notifications_outbox` is as far as it gets.
 * That the row is enqueued is real; that a message arrives on his phone is not
 * proved until S37, and this says so rather than quietly counting it.
 */
import { createPool } from "../src/db.js";

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

const MARK = "s23-quiet-hours";

/** Local wall-clock in New York, as an instant, for a given date and time. */
function nyc(dateIso: string, hhmm: string): Date {
  // EDT in September is UTC-4. The two instants this is used for are both
  // inside that window, and getting it wrong by an hour would move the test
  // across the 19:30 boundary — so it is stated rather than inferred.
  return new Date(`${dateIso}T${hhmm}:00-04:00`);
}

function todayInNy(now = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function arm(): Promise<void> {
  const today = todayInNy();
  /*
   * 18:45 ET. One hour later is 19:45, which is fifteen minutes after quiet
   * hours begin — enough margin that a sweep landing early cannot ring him, and
   * little enough that the evening is not half over before it comes due.
   */
  const dated = nyc(today, "18:45");
  if (dated.getTime() < Date.now()) {
    console.log("  refusing to arm: 18:45 ET has already passed today.");
    console.log("  A task dated in the past comes due immediately, which would ring him now.");
    fail += 1;
    return;
  }

  const project = await pool.query<{ id: string }>(
    `SELECT id FROM projects WHERE slug = 'jarvis-improvement'`);
  const task = await pool.query<{ id: string }>(
    `INSERT INTO tasks (title, objective, lane, state, priority, project_id, waiting_reason, updated_at)
     VALUES ($1, $2, 'system', 'waiting_for_user', 'normal', $3, $4, $5)
     RETURNING id`,
    [
      `${MARK}: confirm the phone stays quiet overnight`,
      "A genuinely blocked task, armed in the afternoon to come due inside quiet hours. "
      + "Nothing should ring until 08:00.",
      project.rows[0]?.id ?? null,
      "Armed for the S23 quiet-hours observation. Nothing is actually blocked on you tonight.",
      dated.toISOString(),
    ],
  );

  console.log(`  armed task ${task.rows[0].id}`);
  console.log(`  dated      ${dated.toISOString()}  (18:45 ET)`);
  console.log(`  due        ${new Date(dated.getTime() + 3600_000).toISOString()}  (19:45 ET, inside quiet hours)`);
  console.log(`  expect     blocked, a WhatsApp row, an Issue, and a retry at 08:00 ET`);
  ok("armed");
}

async function verify(): Promise<void> {
  const task = await pool.query<{ id: string; state: string }>(
    `SELECT id, state FROM tasks WHERE title LIKE $1 ORDER BY created_at DESC LIMIT 1`,
    [`${MARK}%`]);
  if (!task.rows[0]) {
    bad("the armed task exists", "a task", "none — was `arm` ever run?");
    return;
  }
  const taskId = task.rows[0].id;
  console.log(`  task ${taskId} (${task.rows[0].state})`);

  const call = await pool.query<{
    id: string; state: string; blocked_reason: string | null; retry_after: string | null;
    attempts: number; placed_at: string | null; call_control_id: string | null;
  }>(
    `SELECT id, state, blocked_reason, retry_after::text AS retry_after, attempts,
            placed_at::text AS placed_at, call_control_id
     FROM outbound_calls WHERE task_id = $1`, [taskId]);

  if (!call.rows[0]) {
    console.log("  no outbound_calls row yet — the sweep has not considered it. Not due until 19:45 ET.");
    return;
  }
  const c = call.rows[0];
  console.log(`  outbound_call ${c.state}, attempts=${c.attempts}, retry_after=${c.retry_after}`);
  if (c.blocked_reason) console.log(`  reason: ${c.blocked_reason}`);

  console.log("\n########## the phone did not ring in the night ##########\n");
  {
    /*
     * The assertion that matters, and the one that needs no interpretation: a
     * `calls` row from Jarvis's own number, inside the window. Emergency Bypass
     * is on, so if this fires Enrique was woken — which is exactly the failure
     * this test exists to catch, and why it is stated as a row count rather than
     * as an inference from state.
     */
    const rang = await pool.query<{ n: string; at: string | null }>(
      `SELECT count(*)::text AS n, max(started_at)::text AS at FROM calls
       WHERE from_e164 = '+13057866217'
         AND started_at >= $1::timestamptz AND started_at < $2::timestamptz`,
      [nyc(todayInNy(new Date(Date.now() - 12 * 3600_000)), "19:30").toISOString(),
       nyc(todayInNy(), "08:00").toISOString()],
    );
    check("no call was placed between 19:30 and 08:00", "0", rang.rows[0].n);
    if (rang.rows[0].n !== "0") console.log(`        a call started at ${rang.rows[0].at}`);
  }

  console.log("\n########## it was refused, and said when it would come back ##########\n");
  {
    truthy("the call was blocked rather than placed",
      c.state === "blocked" || (c.state === "placed" && c.attempts === 1 && c.retry_after));
    truthy("with quiet hours as the reason",
      (c.blocked_reason ?? "").toLowerCase().includes("quiet")
      || (c.blocked_reason ?? "").includes("08:00")
      || c.state === "placed");
    truthy("and a time to come back", Boolean(c.retry_after));

    const issue = await pool.query<{ title: string; required_action: string; status: string }>(
      `SELECT title, required_action, status FROM issues WHERE task_id = $1`, [taskId]);
    truthy("an Issue was raised", issue.rowCount && issue.rowCount > 0);
    if (issue.rows[0]) {
      console.log(`        issue: ${issue.rows[0].title}`);
      truthy("carrying the retry time",
        /08:00|8:00|morning/i.test(`${issue.rows[0].title} ${issue.rows[0].required_action}`));
    }

    /*
     * Enqueued, not delivered. WhatsApp is not paired, so the outbox row is the
     * end of what can be observed until S37 - stated here rather than counted as
     * a delivered fallback.
     */
    const outbox = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notifications_outbox
       WHERE message_type = 'call_fallback' AND created_at > now() - interval '18 hours'`);
    console.log(`        WhatsApp fallback rows enqueued: ${outbox.rows[0].n} `
      + "(enqueued only — WhatsApp is not paired, delivery is unproved until S37)");
  }

  console.log("\n########## and it came back at 08:00 ##########\n");
  {
    if (c.state === "placed" && c.placed_at) {
      ok(`the retry fired and placed a real call at ${c.placed_at}`);
      truthy("with a call_control_id from Telnyx", Boolean(c.call_control_id));
      const leg = await pool.query<{ state: string; started_at: string }>(
        `SELECT state, started_at::text AS started_at FROM calls WHERE call_control_id = $1`,
        [c.call_control_id]);
      if (leg.rows[0]) console.log(`        leg ${leg.rows[0].state} at ${leg.rows[0].started_at}`);
      console.log("        Enrique confirms the ring — that is the only part needing a human.");
    } else {
      console.log("  not yet: the retry has not fired. Re-run after 08:00 ET.");
    }
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "verify";
  console.log(`S23 quiet hours — ${mode}  (now: ${new Date().toISOString()})\n`);
  if (mode === "arm") await arm();
  else await verify();
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

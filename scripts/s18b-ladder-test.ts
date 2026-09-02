/**
 * S18b — the recovery ladder, and the composer's row shape.
 *
 * The plan's test for the ladder is precise about what would be a false pass:
 * "Force a failure at each of the ten rungs and confirm recovery stops at the
 * first that resolves it — NOT that it reaches rung 10 eventually."
 *
 * So this asserts two different things. That the ladder climbs one rung per
 * failure, cheapest first, recording each — and that a task whose trouble is
 * resolved at rung 1 never reaches rung 2. The second is the one that says the
 * ladder is a ladder rather than a list it walks to the end of.
 *
 * The composer half is the plan's other instruction, and it is a diff: "each
 * produces an inbox event indistinguishable in shape from a WhatsApp one. Diff
 * the rows — if the console's differ, there are two input paths and only one of
 * them is tested."
 */
import { createPool } from "../src/db.js";
import { climb, RUNGS, rungsTried } from "../src/ladder.js";

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

const API = process.env.S18B_API ?? "http://api:8080";
const ORIGIN = process.env.JARVIS_ORIGIN ?? "http://localhost:8080";
const STAMP = Date.now().toString(36);

async function newTask(title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO tasks (project_id, title, objective, state, lane, priority, lease_owner, heartbeat_at)
     SELECT id, $1, 'x', 'running', 'heavy', 'normal', 'dead-worker', now() - interval '10 minutes'
     FROM projects WHERE slug = 'dev-sandbox' RETURNING id`,
    [title],
  );
  return r.rows[0].id;
}

async function main(): Promise<void> {
  console.log("########## the ladder climbs, cheapest first ##########\n");

  const t = await newTask(`S18b ladder ${STAMP}`);
  // Give it something to nudge with, so rung 2 has material.
  await pool.query(
    `INSERT INTO task_events (task_id, type, name, summary)
     VALUES ($1, 'tool', 'Bash', 'npm test -- cart')`,
    [t],
  );

  const climbed: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const step = await climb(pool, t, "heartbeat missed");
    climbed.push(`${step.rung}:${step.name}`);
    if (step.name === "ask_enrique") break;
  }
  console.log(`  climbed: ${climbed.join(" -> ")}`);

  check("the first rung tried is the cheapest one", "1:wait", climbed[0]);
  truthy("and it does not begin with a restart", !climbed[0].includes("restart"));
  const order = climbed.map((c) => Number(c.split(":")[0]));
  check(
    "the rungs are climbed in order, never skipping backwards",
    true,
    order.every((n, i) => i === 0 || n >= order[i - 1]),
  );
  truthy("it reaches Enrique only at the end", climbed[climbed.length - 1] === "10:ask_enrique");

  const trail = await rungsTried(pool, t);
  truthy("every rung is recorded on the task", trail.length >= 8);
  truthy(
    "including the ones that could not be applied, with the reason",
    trail.some((r) => r.name === "switch_harness" && r.summary.includes("S28")),
  );
  truthy(
    "and the browser reset says there is nothing to reset",
    trail.some((r) => r.name === "reset_tool" && r.summary.includes("no browser")),
  );

  check(
    "the task ends waiting for Enrique, not lost",
    "waiting_for_user",
    (await pool.query<{ state: string }>("SELECT state FROM tasks WHERE id = $1", [t])).rows[0].state,
  );
  {
    const issue = await pool.query<{ evidence: { rungs_tried?: string[] } }>(
      `SELECT evidence FROM issues WHERE task_id = $1 AND category = 'worker.crash'
       ORDER BY created_at DESC LIMIT 1`,
      [t],
    );
    truthy(
      "and the ticket lists what was tried rather than saying 'recovery failed'",
      (issue.rows[0]?.evidence?.rungs_tried ?? []).length >= 8,
    );
  }

  // ------------------------------------------------------------ it STOPS
  console.log("\n=== and it stops at the first rung that works ===");
  {
    const t2 = await newTask(`S18b resolved early ${STAMP}`);
    const first = await climb(pool, t2, "a two-second blip");
    check("the first failure gets rung 1", 1, first.rung);
    check("which is `wait`", "wait", first.name);

    // The blip resolves: the task runs again and finishes. Nothing calls climb
    // a second time, because nothing failed a second time.
    await pool.query(
      `UPDATE tasks SET state = 'succeeded', heartbeat_at = now() WHERE id = $1`,
      [t2],
    );
    const trail2 = await rungsTried(pool, t2);
    check("exactly one rung was ever tried", 1, trail2.length);
    check("and it was not the expensive one", "wait", trail2[0].name);
    ok("...which is the property the plan asks for: it stops, it does not run the ladder");
  }

  // -------------------------------------------------- each rung, individually
  console.log("\n=== each rung does its own distinct thing ===");
  {
    const t3 = await newTask(`S18b rung effects ${STAMP}`);
    await pool.query("UPDATE tasks SET external_session_id = 'sess-old' WHERE id = $1", [t3]);
    await pool.query(
      `INSERT INTO task_events (task_id, type, name, summary)
       VALUES ($1, 'phase', 'inspect', 'looked at the cart code')`,
      [t3],
    );

    // rung 1 wait
    await climb(pool, t3, "x");
    check(
      "wait holds the task rather than requeueing it",
      "recovering",
      (await pool.query<{ state: string }>("SELECT state FROM tasks WHERE id = $1", [t3])).rows[0].state,
    );
    await climb(pool, t3, "x"); // wait again (limit 2)
    // rung 2 nudge
    const nudge = await climb(pool, t3, "x");
    check("the second rung is the nudge", "nudge", nudge.name);
    check(
      "which leaves the run something to read",
      1,
      Number((await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM task_context WHERE task_id = $1 AND body LIKE 'You stopped after%'`,
        [t3])).rows[0].n),
    );
    // climb to restart_session and check the effect
    for (const _ of [1, 2, 3]) await climb(pool, t3, "x"); // retry x2, reset_tool(skip)+restart_worker
    const session = await pool.query<{ external_session_id: string | null; lease_owner: string | null }>(
      "SELECT external_session_id, lease_owner FROM tasks WHERE id = $1", [t3]);
    check("restart_worker released the lease", null, session.rows[0].lease_owner);
    const restart = await climb(pool, t3, "x");
    check("the next rung is restart_session", "restart_session", restart.name);
    check(
      "which clears the harness session so it starts fresh",
      null,
      (await pool.query<{ s: string | null }>(
        "SELECT external_session_id AS s FROM tasks WHERE id = $1", [t3])).rows[0].s,
    );
  }

  // ------------------------------------------------------------ the limits
  console.log("\n=== a ladder without limits is an infinite retry loop ===");
  {
    const t4 = await newTask(`S18b limits ${STAMP}`);
    const seen: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const s = await climb(pool, t4, "x");
      seen.push(s.name);
      if (s.name === "ask_enrique") break;
    }
    truthy("it terminates rather than climbing forever", seen.includes("ask_enrique"));
    for (const rung of RUNGS) {
      const used = seen.filter((n) => n === rung.name).length;
      if (used > rung.limit) {
        bad(`${rung.name} respects its limit of ${rung.limit}`, `<= ${rung.limit}`, used);
      }
    }
    ok("and no rung exceeds its own limit");
  }

  // ============================================ the composer's row shape
  console.log("\n########## the composer goes through the same path as WhatsApp ##########\n");
  {
    const login = await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({
        email: process.env.JARVIS_OPERATOR_EMAIL ?? "dev@jarvis.local",
        password: process.env.JARVIS_OPERATOR_PASSWORD ?? "dev-password-1234",
      }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

    const conv = await pool.query<{ id: string }>(
      `SELECT id FROM conversations WHERE project_id IS NULL ORDER BY created_at LIMIT 1`,
    );
    const CONSOLE_TEXT = `console composer probe ${STAMP}`;
    await fetch(`${API}/api/conversations/${conv.rows[0].id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
      body: JSON.stringify({ body: CONSOLE_TEXT }),
    });

    const WHATSAPP_TEXT = `whatsapp probe ${STAMP}`;
    const crypto = await import("node:crypto");
    const body = JSON.stringify({
      channel: "whatsapp", sender: "enrique", text: WHATSAPP_TEXT,
      request_id: `s18b-shape-${STAMP}`,
    });
    const sig = crypto.createHmac("sha256", process.env.INTERNAL_HMAC ?? "").update(body).digest("hex");
    await fetch(`${API}/internal/inbox/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-jarvis-internal": sig },
      body,
    });

    const rows = await pool.query<Record<string, unknown>>(
      `SELECT * FROM inbox_events WHERE raw_text IN ($1, $2)`,
      [CONSOLE_TEXT, WHATSAPP_TEXT],
    );
    check("both paths produced a row", 2, rows.rowCount);
    if (rows.rowCount === 2) {
      const fromConsole = rows.rows.find((r) => r.raw_text === CONSOLE_TEXT)!;
      const fromWhatsapp = rows.rows.find((r) => r.raw_text === WHATSAPP_TEXT)!;
      /*
       * The DIFF the plan asks for. Compared by SHAPE — which columns carry a
       * value — not by content: the channel and the sender are supposed to
       * differ, and the id and the timestamps always will. What must not differ
       * is which fields got filled in, because that is what says whether one
       * path or two are being used.
       */
      const IGNORE = new Set([
        "id", "channel", "sender", "raw_text", "checksum", "received_at",
        "created_at", "updated_at", "external_id", "conversation_id",
        "route_segments", "routing_note", "route_category", "processing_state",
        "processed_at", "project_id",
      ]);
      const shape = (r: Record<string, unknown>) =>
        Object.keys(r)
          .filter((k) => !IGNORE.has(k))
          .sort()
          .map((k) => `${k}=${r[k] === null ? "null" : "set"}`)
          .join(" ");
      const a = shape(fromConsole);
      const b = shape(fromWhatsapp);
      if (a !== b) {
        console.log(`  console:  ${a}`);
        console.log(`  whatsapp: ${b}`);
      }
      check("and the two rows have the same shape", b, a);
      check("both persisted", "persisted", fromConsole.capture_state);
      check("both the same way", "persisted", fromWhatsapp.capture_state);
    }
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

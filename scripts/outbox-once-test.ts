/**
 * One queued notification produces exactly one WhatsApp message.
 *
 * Written after the delivery loop of 2026-09-03, in which Enrique received the
 * same ten messages three and four times each. Three separate faults stacked,
 * and this suite covers the two that live in Jarvis:
 *
 *  1. `sendViaBridge` returned `res.ok` - the HTTP status of the bridge ROUTE.
 *     The bridge answers 200 with {"ok": false} when the send itself failed, so
 *     every failed delivery was recorded as sent. The outbox held 273 rows, all
 *     `sent`, all `attempts = 1`, while OpenClaw logged 34 failed sends. Jarvis
 *     was not just wrong about one message - it was structurally blind, and its
 *     own retry curve could never fire because it never saw a failure.
 *  2. That curve, when it did fire, was a SECOND retry ladder underneath
 *     OpenClaw's, which held 65 entries and retried each about 150 times in
 *     twenty minutes. Retry is transport (II.2c). Two ladders do not make
 *     delivery more likely; they multiply the messages.
 *
 * The third fault was outside Jarvis - the WhatsApp Web listener was inactive
 * for four hours, so everything failed and OpenClaw queued it all for redelivery
 * - and it is exactly why the two above matter. A transport WILL fail for hours
 * at a time, and the system has to behave when it does.
 *
 * The assertion that matters is the count of HTTP requests to the bridge, not
 * the state of a row: a row can say anything, while a request is a message on
 * somebody's phone.
 */
import { createServer, type Server } from "node:http";
import { createPool } from "../src/db.js";

process.env.INTERNAL_HMAC = process.env.INTERNAL_HMAC ?? "test-secret";

let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); pass += 1; };
const bad = (m: string, extra?: unknown) => {
  console.log(`  FAIL - ${m}${extra === undefined ? "" : `: ${String(extra).slice(0, 200)}`}`);
  fail += 1;
};

const STAMP = Date.now().toString(36).slice(-6);
const ids: string[] = [];
let unconfirmedId = "";

/** A bridge that answers however the test tells it to, and counts requests. */
type Reply = { status: number; body: string };
let reply: Reply = { status: 200, body: JSON.stringify({ ok: true }) };

/*
 * Counted PER ROW, not in total. The dev queue holds other pending
 * notifications and the drain takes twenty at a time, so a global counter
 * measures whatever else happened to be queued - the first version of this test
 * reported four requests for one row and was measuring the neighbours.
 */
const sentFor = new Map<string, number>();
const countFor = (id: string) => sentFor.get(id) ?? 0;

function fakeBridge(): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const id = String((JSON.parse(body) as { id?: string }).id ?? "");
          if (id) sentFor.set(id, countFor(id) + 1);
        } catch { /* unparseable body: not one of ours */ }
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function main(): Promise<void> {
  const srv = await fakeBridge();
  const port = (srv.address() as { port: number }).port;
  process.env.JARVIS_BRIDGE_SEND_URL = `http://127.0.0.1:${port}/jarvis/send`;

  // Imported AFTER the env is set: the module reads the URL at load time.
  const { drainOutbox } = await import("../src/worker.js");
  const pool = createPool();

  /* A commanding identity has to exist or nothing is ever sent. */
  await pool.query(
    `INSERT INTO channel_allowlist (channel, identifier, can_command)
     VALUES ('whatsapp', $1, true) ON CONFLICT DO NOTHING`, [`+1555${STAMP}`]);

  const queue = async (body: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO notifications_outbox (channel, message_type, body, idempotency_key, state, next_attempt_at)
       VALUES ('whatsapp','test',$1,$2,'pending', now()) RETURNING id`,
      [body, `outbox-once:${STAMP}:${body}`]);
    ids.push(r.rows[0].id);
    return r.rows[0].id;
  };
  const stateOf = async (id: string) => {
    const r = await pool.query<{ state: string; attempts: number }>(
      `SELECT state, attempts FROM notifications_outbox WHERE id = $1`, [id]);
    return r.rows[0];
  };

  console.log("\n########## a confirmed send is sent once ##########\n");
  {
    reply = { status: 200, body: JSON.stringify({ ok: true }) };
    const id = await queue(`confirmed ${STAMP}`);
    await drainOutbox(pool);
    const s = await stateOf(id);
    s.state === "sent" ? ok("a confirmed delivery is marked sent") : bad(`state is ${s.state}`);
    countFor(id) === 1 ? ok("and exactly one message was sent") : bad(`${countFor(id)} messages`);

    await drainOutbox(pool);
    countFor(id) === 1 ? ok("a second drain does not send it again") : bad(`${countFor(id)} after redrain`);
  }

  console.log("\n########## the bridge saying no is not a delivery ##########\n");
  {
    /*
     * The exact shape that caused the incident: HTTP 200, with the send having
     * failed inside it. Reading res.ok here is what recorded 273 deliveries
     * that had not happened.
     */
    reply = { status: 200, body: JSON.stringify({ ok: false, error: "No active WhatsApp Web listener" }) };
    const id = await queue(`unconfirmed ${STAMP}`);
    await drainOutbox(pool);

    const s = await stateOf(id);
    s.state !== "sent"
      ? ok(`HTTP 200 with ok:false is not recorded as sent (state ${s.state})`)
      : bad("a failed send was recorded as sent - this is the incident");
    countFor(id) === 1 ? ok("one attempt was made") : bad(`${countFor(id)} messages`);
    unconfirmedId = id;
  }

  console.log("\n########## Jarvis does not retry on top of the transport ##########\n");
  {
    /*
     * The heart of it. OpenClaw owns retry and is already retrying this; if
     * Jarvis drains again and sends again, the two ladders multiply. Drained
     * five times, because the old curve would have spent up to seven attempts.
     */
    for (let i = 0; i < 5; i += 1) await drainOutbox(pool);
    countFor(unconfirmedId) === 1
      ? ok("five further drains sent nothing more - still exactly one message")
      : bad(`Jarvis re-sent it ${countFor(unconfirmedId) - 1} time(s) on top of the transport`);

    const issue = await pool.query<{ title: string }>(
      `SELECT title FROM issues WHERE dedupe_key = 'outbox.unconfirmed:whatsapp'
        ORDER BY created_at DESC LIMIT 1`);
    issue.rows[0]
      ? ok("and the unconfirmed delivery is raised as an Issue rather than lost")
      : bad("nothing was raised, so an undelivered message is silently dropped");
  }

  console.log("\n########## an unpaired channel is not a failed send ##########\n");
  {
    /*
     * Kept distinct on purpose: nothing was put on the wire, so deferring
     * cannot duplicate anything. This is the one case that still waits.
     */
    reply = { status: 200, body: JSON.stringify({ ok: false, unavailable: true, error: "not paired" }) };
    const id = await queue(`unpaired ${STAMP}`);
    await drainOutbox(pool);
    const s = await stateOf(id);
    s.state === "pending" ? ok("an unpaired channel leaves the row pending") : bad(`state is ${s.state}`);
    s.attempts === 0 ? ok("without spending an attempt") : bad(`attempts is ${s.attempts}`);
  }

  srv.close();
  await pool.query(`DELETE FROM notifications_outbox WHERE id = ANY($1::uuid[])`, [ids]).catch(() => undefined);
  await pool.query(`DELETE FROM channel_allowlist WHERE identifier = $1`, [`+1555${STAMP}`]).catch(() => undefined);
  await pool.query(`DELETE FROM issues WHERE dedupe_key = 'outbox.unconfirmed:whatsapp'`).catch(() => undefined);
  await pool.end().catch(() => undefined);

  console.log("");
  console.log(`==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

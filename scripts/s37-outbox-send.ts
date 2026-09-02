/**
 * S37 item 4 - notifications_outbox reaches the WhatsApp bridge, exactly once.
 *
 * The delivery itself cannot be observed before Enrique pairs the phone, so
 * what is asserted here is everything on this side of that boundary: that the
 * worker calls the bridge at all, with the right recipient and a signature the
 * bridge would accept, that a 2xx marks the row sent and a failure does not,
 * and above all that N sweeps produce exactly ONE send per row. "Not zero, not
 * twice" was the requirement; twice is the half a naive retry loop gets wrong.
 *
 * The bridge is replaced by a stand-in HTTP server that records what it was
 * asked to send. That is the point of the seam: the real bridge was separately
 * proven live, up to "Channel is unavailable: whatsapp".
 */
import http from "node:http";
import crypto from "node:crypto";
import { createPool } from "../src/db.js";

const SECRET = process.env.INTERNAL_HMAC ?? "test-secret";
let fails = 0;
const ok = (m: string) => console.log(`  ok   - ${m}`);
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails++; };

type Seen = { id: string; to: string; text: string; signatureValid: boolean };

async function main() {
  const pool = createPool();
  const seen: Seen[] = [];
  let respondWith = 200;
  let unavailable = false;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const expected = crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
      const body = JSON.parse(raw);
      seen.push({
        id: body.id, to: body.to, text: body.text,
        signatureValid: req.headers["x-jarvis-internal"] === expected,
      });
      res.statusCode = respondWith;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(
        respondWith === 200
          ? { ok: true }
          : { ok: false, detail: unavailable ? "Channel is unavailable: whatsapp" : "boom" },
      ));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env.JARVIS_BRIDGE_SEND_URL = `http://127.0.0.1:${port}/jarvis/send`;

  // Imported AFTER the URL is set: the module reads it once, at load.
  const { drainOutbox } = await import("../src/worker.js");

  // The sweep takes the twenty OLDEST pending rows, so a dev database carrying
  // dozens of revived notifications would never reach a row inserted now - the
  // first run of this test asserted zero sends for exactly that reason. This is
  // the disposable dev database, not production.
  await pool.query(`DELETE FROM notifications_outbox`);
  await pool.query(
    `INSERT INTO channel_allowlist (channel, identifier, display, can_command)
     VALUES ('whatsapp', '+15550001111', 'Test', true)
     ON CONFLICT (channel, identifier) DO NOTHING`,
  );
  const { rows: [row] } = await pool.query<{ id: string }>(
    `INSERT INTO notifications_outbox (channel, body, state, next_attempt_at)
     VALUES ('whatsapp', 's37-test one', 'pending', now()) RETURNING id`,
  );

  console.log("1. the worker hands a pending notification to the bridge");
  await drainOutbox(pool);
  const mine = () => seen.filter((s) => s.text.startsWith("s37-test"));
  if (mine().length === 1) ok("one send"); else bad(`${mine().length} sends, expected 1`);
  if (mine()[0]?.signatureValid) ok("signed with INTERNAL_HMAC"); else bad("signature the bridge would reject");
  if (mine()[0]?.to) ok(`addressed to the commanding identity ${mine()[0].to}`);
  else bad("no recipient");

  console.log("2. a delivered row is marked sent");
  const after = await pool.query<{ state: string; last_error: string | null }>(
    `SELECT state, last_error FROM notifications_outbox WHERE id = $1`, [row.id]);
  after.rows[0]?.state === "sent"
    ? ok("state=sent")
    : bad(`state=${after.rows[0]?.state} last_error=${after.rows[0]?.last_error}`);

  console.log("3. exactly once - further sweeps do not send it again");
  await drainOutbox(pool);
  await drainOutbox(pool);
  mine().length === 1 ? ok("still one send after three sweeps") : bad(`${mine().length} sends after three sweeps`);

  console.log("4. a failed send is not marked sent, and is retried");
  respondWith = 502;
  const { rows: [row2] } = await pool.query<{ id: string }>(
    `INSERT INTO notifications_outbox (channel, body, state, next_attempt_at)
     VALUES ('whatsapp', 's37-test two', 'pending', now()) RETURNING id`,
  );
  await drainOutbox(pool);
  const f = await pool.query<{ state: string; attempts: number; last_error: string }>(
    `SELECT state, attempts, last_error FROM notifications_outbox WHERE id = $1`, [row2.id],
  );
  f.rows[0]?.state === "pending" ? ok("still pending") : bad(`state=${f.rows[0]?.state}`);
  f.rows[0]?.attempts === 1 ? ok("attempts=1") : bad(`attempts=${f.rows[0]?.attempts}`);
  (f.rows[0]?.last_error ?? "").includes("502") ? ok("the real error is recorded") : bad(`last_error=${f.rows[0]?.last_error}`);

  console.log("5. an unpaired channel defers without spending an attempt");
  // The queue has to survive intact until the phone is paired. Spending the
  // retry budget on a channel that does not exist yet would mark it failed and
  // deliver zero, which is the failure Enrique named first.
  respondWith = 503;
  unavailable = true;
  const { rows: [row3] } = await pool.query<{ id: string }>(
    `INSERT INTO notifications_outbox (channel, body, state, next_attempt_at)
     VALUES ('whatsapp', 's37-test three', 'pending', now()) RETURNING id`,
  );
  await drainOutbox(pool);
  await pool.query(`UPDATE notifications_outbox SET next_attempt_at = now() WHERE id = $1`, [row3.id]);
  await drainOutbox(pool);
  const u = await pool.query<{ state: string; attempts: number; last_error: string }>(
    `SELECT state, attempts, last_error FROM notifications_outbox WHERE id = $1`, [row3.id],
  );
  u.rows[0]?.attempts === 0 ? ok("attempts still 0 after two refusals") : bad(`attempts=${u.rows[0]?.attempts}`);
  u.rows[0]?.state === "pending" ? ok("still queued for delivery") : bad(`state=${u.rows[0]?.state}`);
  (u.rows[0]?.last_error ?? "").includes("not paired yet") ? ok("recorded as unpaired, not as a failure") : bad(`last_error=${u.rows[0]?.last_error}`);

  await pool.query(`DELETE FROM notifications_outbox WHERE body LIKE 's37-test%'`);
  await pool.query(`DELETE FROM channel_allowlist WHERE identifier = '+15550001111'`);
  server.close();
  await pool.end();

  console.log(fails === 0 ? "\nS37 outbox send PASS" : `\nS37 outbox send FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

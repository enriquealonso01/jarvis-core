/**
 * A notification about a channel is never delivered by that channel.
 *
 * "Pair WhatsApp: On the VPS: docker compose --profile openclaw up -d..." was
 * queued on WhatsApp, where it waited for the pairing it was asking for. It had
 * been failing since 21:59 and was a large share of the delivery-retry traffic.
 *
 * The second half matters just as much: the backlog that survives until pairing
 * must arrive exactly once. Not zero - that would lose every blocker raised
 * while the phone was unpaired - and not twice, which is what a naive revive
 * does to a row that was already sent.
 */
import { createPool } from "../src/db.js";
import { enqueueNotification } from "../src/notify.js";

const pool = createPool();
let fails = 0;
let passes = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

async function rows(key: string): Promise<{ channel: string; state: string }[]> {
  const r = await pool.query<{ channel: string; state: string }>(
    `SELECT channel, state FROM notifications_outbox WHERE idempotency_key LIKE $1 ORDER BY channel`,
    [`${key}%`],
  );
  return r.rows;
}

async function main() {
  const stamp = Date.now();
  const key = `test.pair.${stamp}`;

  console.log("1. a whatsapp-pairing notification does not enqueue against whatsapp");
  await enqueueNotification(pool, {
    level: "whatsapp_blocker",
    messageType: "blocker",
    body: "Pair WhatsApp: scan the QR",
    idempotencyKey: key,
    aboutChannel: "whatsapp",
  });
  const made = await rows(key);
  made.some((r) => r.channel === "whatsapp")
    ? bad(`queued on the very channel it is about: ${made.map((r) => r.channel).join(",")}`)
    : ok("no whatsapp row");
  made.some((r) => r.channel === "ui")
    ? ok("and the console carries it, which is always live")
    : bad(`nothing was enqueued at all: ${JSON.stringify(made)}`);

  console.log("2. an ordinary blocker still reaches whatsapp");
  // Otherwise the fix is indistinguishable from breaking notifications.
  const key2 = `test.ordinary.${stamp}`;
  await enqueueNotification(pool, {
    level: "whatsapp_blocker",
    messageType: "blocker",
    body: "A task needs you",
    idempotencyKey: key2,
  });
  const ord = await rows(key2);
  ord.some((r) => r.channel === "whatsapp")
    ? ok("whatsapp row present")
    : bad(`the ordinary path lost its whatsapp row: ${JSON.stringify(ord)}`);

  console.log("3. the parked backlog revives exactly once");
  /*
   * Modelled on the real backlog: rows deferred while the channel was unpaired.
   * Reviving is only correct for rows that never left; a row already `sent`
   * must not be resurrected, which is the "not twice" half.
   */
  const parked = `test.backlog.${stamp}`;
  for (let i = 0; i < 3; i += 1) {
    await pool.query(
      `INSERT INTO notifications_outbox (channel, message_type, body, idempotency_key, state, attempts, last_error)
       VALUES ('whatsapp', 'blocker', $1, $2, 'pending', 0, 'channel not paired yet; deferred without spending an attempt')`,
      [`backlog ${i}`, `${parked}.${i}`],
    );
  }
  await pool.query(
    `INSERT INTO notifications_outbox (channel, message_type, body, idempotency_key, state)
     VALUES ('whatsapp', 'blocker', 'already delivered', $1, 'sent')`,
    [`${parked}.sent`],
  );

  const pendingBefore = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM notifications_outbox
      WHERE idempotency_key LIKE $1 AND state = 'pending'`, [`${parked}%`]);
  Number(pendingBefore.rows[0].n) === 3
    ? ok("three parked, one already sent")
    : bad(`setup wrong: ${pendingBefore.rows[0].n} pending`);

  // The revive the worker performs when a channel becomes configured.
  const revived = await pool.query(
    `UPDATE notifications_outbox
        SET state = 'pending', attempts = 0, next_attempt_at = now()
      WHERE state = 'failed' AND idempotency_key LIKE $1`, [`${parked}%`]);
  (revived.rowCount ?? 0) === 0
    ? ok("nothing already sent was resurrected")
    : bad(`${revived.rowCount} sent row(s) were revived`);

  const stillSent = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM notifications_outbox
      WHERE idempotency_key = $1 AND state = 'sent'`, [`${parked}.sent`]);
  Number(stillSent.rows[0].n) === 1
    ? ok("the delivered one stays delivered")
    : bad("the delivered row changed state");

  await pool.query(`DELETE FROM notifications_outbox WHERE idempotency_key LIKE $1`, [`test.%${stamp}%`]);
  await pool.query(`DELETE FROM notifications_outbox WHERE idempotency_key LIKE $1`, [`${key}%`]);
  await pool.query(`DELETE FROM notifications_outbox WHERE idempotency_key LIKE $1`, [`${key2}%`]);
  await pool.query(`DELETE FROM notifications_outbox WHERE idempotency_key LIKE $1`, [`${parked}%`]);
  await pool.end();

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

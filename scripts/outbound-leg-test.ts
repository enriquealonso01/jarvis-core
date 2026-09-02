/**
 * Jarvis must not hang up on itself.
 *
 * Telnyx sends `call.initiated` for outbound legs as well as inbound ones, and
 * the owner check was applied to both. So every call Jarvis placed was measured
 * against "is the caller Enrique?", answered no - the caller is Jarvis - and was
 * rejected, with a security Issue raised each time. Five in one day.
 *
 * The calls appeared to work anyway: a later event arriving with no call row
 * invents one, so the conversation carried on and the rejection was invisible
 * except as a ticket nobody connected to it.
 *
 * Driven by synthesised webhooks against the real handler with
 * JARVIS_TELNYX=fake, so the commands that would have gone to Telnyx are
 * recorded instead of sent.
 */
import { createPool } from "../src/db.js";
import { clearSentCommands, handleCallEvent, sentCommands } from "../src/callcontrol.js";

const pool = createPool();
let fails = 0;
const ok = (m: string) => console.log(`  ok   - ${m}`);
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails++; };

const JARVIS = "+13057866217";
const OWNER = "+13055052646";
const STRANGER = "+12125550000";

const initiated = (ccid: string, from: string, extra: Record<string, unknown> = {}) => ({
  data: {
    event_type: "call.initiated",
    payload: { call_control_id: ccid, call_leg_id: `${ccid}-leg`, from, ...extra },
  },
});

const actions = (ccid: string) => sentCommands.filter((c) => c.ccid === ccid).map((c) => c.action);

/**
 * Rows AND occurrences.
 *
 * `raiseIssue` dedupes on a key, so the fifth spurious rejection does not add a
 * row - it increments `occurrences` on the existing one. Counting rows alone
 * therefore passed while the sabotaged code was raising a ticket on every single
 * call, which is exactly the blind spot that let this run for a day in
 * production with the evidence sitting in the table.
 */
async function issueWeight(): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT coalesce(count(*), 0) + coalesce(sum(occurrences), 0) AS n
       FROM issues WHERE title LIKE '%unrecognised number%'`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function main() {
  console.log("1. our own outbound leg is not rejected");
  clearSentCommands();
  const before = await issueWeight();
  const ccid = `out-${Date.now()}`;
  await pool.query(
    `INSERT INTO outbound_calls (reason, subject, state, call_control_id)
     VALUES ('test', 'outbound leg test', 'placed', $1)`,
    [ccid],
  );
  const said = await handleCallEvent(pool, initiated(ccid, JARVIS) as never);
  actions(ccid).includes("reject")
    ? bad(`rejected our own outbound leg: ${actions(ccid).join(",")}`)
    : ok(`no reject (${said})`);
  actions(ccid).includes("answer")
    ? bad("answered our own outbound leg - the callee answers, not us")
    : ok("no answer either");

  console.log("2. it raises no security Issue");
  const after = await issueWeight();
  after === before ? ok("no ticket raised or incremented") : bad(`raised or bumped a ticket ${after - before} time(s)`);

  console.log("3. the row exists, so later events are not orphaned");
  const row = await pool.query(`SELECT 1 FROM calls WHERE call_control_id = $1`, [ccid]);
  row.rowCount ? ok("call row opened") : bad("no call row; later events would invent one");

  console.log("4. an unknown caller is still rejected");
  clearSentCommands();
  const bad1 = `in-${Date.now()}`;
  await handleCallEvent(pool, initiated(bad1, STRANGER) as never);
  actions(bad1).includes("reject")
    ? ok("stranger rejected")
    : bad(`a stranger was NOT rejected: ${actions(bad1).join(",") || "no commands"}`);

  console.log("5. a spoofed caller ID claiming to be us gets nothing");
  // The from-matches-our-number signal is caller-controlled, so it must never
  // grant anything. It does not: an outbound leg is neither answered nor
  // rejected, so the spoofer reaches silence.
  clearSentCommands();
  const spoof = `spoof-${Date.now()}`;
  await handleCallEvent(pool, initiated(spoof, JARVIS) as never);
  actions(spoof).includes("answer")
    ? bad("a spoofed caller ID was ANSWERED")
    : ok("not answered");

  await pool.query(`DELETE FROM outbound_calls WHERE call_control_id = $1`, [ccid]);
  await pool.query(`DELETE FROM calls WHERE call_control_id = ANY($1)`, [[ccid, bad1, spoof]]);
  await pool.end();

  console.log(fails === 0 ? "\nOutbound leg PASS" : `\nOutbound leg FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

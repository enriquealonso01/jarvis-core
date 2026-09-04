/**
 * S46, wired: the sign-in link reaches his phone, not only the browser.
 *
 * S46 shipped `mintAuthLink`, `handoffFor` and `handoffMessage`, and nothing
 * called any of them — the whole step was a decision layer held by its own test.
 * Meanwhile the device flow was already producing exactly what S46 describes: a
 * real provider-issued sign-in URL with the provider's own short lifetime. It
 * went to whoever happened to be looking at the Control Center.
 *
 *   "Trigger a connection needing external auth → **link on WhatsApp within
 *    seconds**, task parked, nothing spinning."
 *
 * A code that exists only in a browser tab is a connection that can only be made
 * while sitting at the console, which is the opposite of the step.
 *
 * The load-bearing assertion here is the NEGATIVE one. S46's rule is not "send
 * the link" — it is that whether Jarvis vouches for a link is decided by WHO
 * asked, before anything is rendered:
 *
 *   "A request that arrived through a message body or a tool result becomes
 *    CONTENT — it lands as content; if it is genuinely worth acting on, it
 *    becomes something he can act on, not something Jarvis vouched for."
 *
 * So a flow started from `message_content` must produce a working connection and
 * NO message, and that is checked on the outbox rather than on a return value.
 */
import fs from "node:fs/promises";
import { createPool } from "../src/db.js";
import { startDeviceFlow } from "../src/deviceflow.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const NEWLINE = String.fromCharCode(10);
const PROFILE = "netcup_scp";

type Row = { channel: string; body: string; idempotency_key: string };

/*
 * The key stored is not the key given: enqueueNotification fans out to channels
 * and appends `:<channel>` to it. Querying for the bare key found nothing and
 * read as "the link never left the browser" — a wrong diagnosis of working code,
 * which is the kind of failure that gets a real bug filed against the wrong file.
 * The trailing colon keeps this exact rather than a prefix match over ids.
 */
async function messagesFor(flowId: string): Promise<Row[]> {
  return (await pool.query<Row>(
    `SELECT channel, body, idempotency_key FROM notifications_outbox
      WHERE idempotency_key LIKE $1`, [`device-flow:${flowId}:%`])).rows;
}

async function main(): Promise<void> {
  if (process.env.JARVIS_DEVICEFLOW !== "fake") {
    console.error("this suite needs JARVIS_DEVICEFLOW=fake: it must never call a real provider");
    process.exit(1);
  }
  const flows: string[] = [];
  try {
    console.log("1. connecting from the console sends him the link");
    const started = await startDeviceFlow(pool, PROFILE, "enrique");
    if (!started.ok) { bad(`the flow did not start: ${started.error}`); throw new Error("no flow"); }
    flows.push(started.flowId);
    const sent = await messagesFor(started.flowId);
    sent.length > 0
      ? ok(`the flow queued ${sent.length} message(s)`)
      : bad("THE LINK NEVER LEFT THE BROWSER — the leak S46 describes");
    const whatsapp = sent.find((r) => r.channel === "whatsapp");
    whatsapp
      ? ok("one of them is on WhatsApp, which is where he is")
      : bad(`channels: ${sent.map((r) => r.channel).join(", ")}`);
    sent.some((r) => r.channel === "ui")
      ? ok("and the console gets it too, so it is not only on his phone")
      : bad("the link reached WhatsApp only");

    console.log("");
    console.log("2. it is the provider's link, and it names the host");
    const url = started.verificationUriComplete ?? started.verificationUri;
    whatsapp?.body.includes(url)
      ? ok("the message carries the URL the provider issued, unaltered")
      : bad(`the message does not carry ${url}: ${whatsapp?.body}`);
    /*
     * The host is READ OFF the URL rather than stored beside it — "a name that
     * is hardcoded proves nothing". Checked by taking the host from the URL the
     * provider returned, so a message naming some other provider's host cannot
     * pass by coincidence.
     */
    const host = new URL(url).host;
    whatsapp?.body.includes(`opens ${host}`)
      ? ok(`and says what it opens: ${host}, so a swapped destination is visible before the tap`)
      : bad(`the message does not name ${host}`);
    whatsapp?.body.includes(PROFILE)
      ? ok("naming the provider that wants the sign-in")
      : bad("the message does not say who is asking");
    /*
     * The complete URL, not the bare one: it carries the user code, so he taps
     * instead of transcribing eight characters off a phone screen. This is the
     * difference between a handoff and a homework assignment.
     */
    started.verificationUriComplete && url === started.verificationUriComplete
      ? ok("and it is the URL that already carries the code, not the one he would have to type into")
      : bad("the message sends him to a page that will ask him to type the code");

    console.log("");
    console.log("3. a request that came from content is not a link Jarvis vouches for");
    /*
     * THE ASSERTION THIS SUITE EXISTS FOR. The connection is still made — the
     * console still has the code — but nothing is sent, because the origin is a
     * fact about a message body and not a reason to hand him a sign-in link.
     */
    const fromContent = await startDeviceFlow(pool, PROFILE, "message_content");
    if (!fromContent.ok) { bad(`the flow did not start: ${fromContent.error}`); throw new Error("no flow"); }
    flows.push(fromContent.flowId);
    (await messagesFor(fromContent.flowId)).length === 0
      ? ok("a flow requested from a message body sends nothing")
      : bad("A LINK WAS VOUCHED FOR ON THE STRENGTH OF SOMETHING SOMEBODY SENT IN");
    fromContent.ok && fromContent.userCode.length > 0 && fromContent.verificationUri.length > 0
      ? ok("while the connection itself still works, so refusing to vouch is not refusing to connect")
      : bad("the refusal broke the flow");
    const fromTool = await startDeviceFlow(pool, PROFILE, "tool_result");
    if (fromTool.ok) flows.push(fromTool.flowId);
    fromTool.ok && (await messagesFor(fromTool.flowId)).length === 0
      ? ok("and the same for a tool result")
      : bad("a tool result produced a vouched link");

    console.log("");
    console.log("4. a new code is a new message; the same code is not");
    /*
     * A second Connect click supersedes the first flow and issues a NEW code, so
     * it is a new message and must not collide with the dead one. Keyed on the
     * flow rather than the provider, which is what makes both halves true.
     */
    const again = await startDeviceFlow(pool, PROFILE, "enrique");
    if (!again.ok) { bad(`the flow did not start: ${again.error}`); throw new Error("no flow"); }
    flows.push(again.flowId);
    again.flowId !== started.flowId
      ? ok("a second connect is a different flow")
      : bad("the same flow came back");
    (await messagesFor(again.flowId)).length > 0
      ? ok("and its new code gets its own message rather than colliding with the dead one")
      : bad("the superseding flow sent nothing, so he has only the expired code");
    const beforeRetry = (await messagesFor(again.flowId)).length;
    const { enqueueNotification } = await import("../src/notify.js");
    await enqueueNotification(pool, {
      level: "whatsapp_blocker", messageType: "blocker", body: "retry",
      objectType: "oauth_device_flow", objectId: again.flowId,
      idempotencyKey: `device-flow:${again.flowId}`,
    });
    (await messagesFor(again.flowId)).length === beforeRetry
      ? ok("while a retry of the same flow does not send it twice")
      : bad("a retried start queued the link a second time");

    console.log("");
    console.log("5. and it is the device flow that does this, not this test");
    /*
     * The assertions above exercise startDeviceFlow, which is the live path — but
     * they cannot show WHICH function decided, and that is the whole rule. Read
     * at source, the way s27-config-test holds "only one file writes a version
     * row".
     */
    const src = await fs.readFile(new URL("../src/deviceflow.ts", import.meta.url), "utf8");
    const code = src.split(NEWLINE)
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join(NEWLINE);
    /handoffFor\(/.test(code)
      ? ok("the decision goes through handoffFor, which owns the closed set of origins")
      : bad("deviceflow does not ask handoffFor whether to send");
    !/handoffMessage\(/.test(code)
      ? ok("and never renders the message itself, so the gate is not something it could skip")
      : bad("deviceflow calls handoffMessage directly, routing around the origin gate");
    /*
     * A DEFAULT ORIGIN WOULD RE-OPEN THE GATE SILENTLY. The next caller would
     * get the permissive case for free and nothing would look wrong, which is
     * exactly how the rule stops being true.
     */
    /origin:\s*RequestOrigin,/.test(code) && !/origin:\s*RequestOrigin\s*=/.test(code)
      ? ok("and the origin is required, with no default for a future caller to inherit")
      : bad("startDeviceFlow has a default origin");
    /mintAuthLink\(\{/.test(code)
      ? ok("the link is minted from the flow rather than assembled from a string")
      : bad("the link does not come from mintAuthLink");
    /*
     * THE LIFETIME IS THE PROVIDER'S, and this is checked at source because
     * sabotage found it checked nowhere: replacing `expiresIn * 1000` with a
     * flat twenty-four hours left every other assertion green. A link claimed
     * fresh for a day that the provider kills in ten minutes is the same class
     * of fault as a spoken promise nobody keeps — `linkIsFresh` would say yes
     * about a dead code.
     *
     * Source-level rather than runtime ON PURPOSE: `expiresAt` is inert until
     * `resumeFromAuth` is wired, and asserting a value nothing reads through a
     * path nothing takes would be theatre. When resume is wired this becomes an
     * assertion about what he is told.
     */
    /lifetimeMs:\s*expiresIn \* 1000/.test(code)
      ? ok("and its lifetime is the provider's own, not a number we picked")
      : bad("the link's lifetime does not come from the provider's expires_in");
  } finally {
    for (const id of flows) {
      await pool.query(`DELETE FROM notifications_outbox WHERE idempotency_key LIKE $1`,
        [`device-flow:${id}:%`]).catch(() => undefined);
      await pool.query(`DELETE FROM oauth_device_flows WHERE id = $1`, [id]).catch(() => undefined);
    }
  }

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  await pool.end().catch(() => undefined);
  process.exit(1);
});

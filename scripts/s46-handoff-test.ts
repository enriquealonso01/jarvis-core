/**
 * S46 — the auth handoff, which is the highest-trust message in the system.
 *
 *   "**An auth link is the exact shape a phishing attempt would want Jarvis to
 *    deliver**: a sign-in page Jarvis vouched for, arriving in the channel he
 *    trusts most."
 *
 * The plan's own test is the one this suite is built around:
 *
 *   "**An inbound message containing a plausible *reconnect your account* link →
 *    no handoff is sent.** It lands as content."
 *
 *   "The handoff message names the provider and the destination host. **Change the
 *    destination in the flow and the message changes with it — a name that is
 *    hardcoded proves nothing.**"
 *
 * So the host assertion is made by CHANGING the flow and watching the message
 * follow, not by checking that some correct-looking host appears. And the lane
 * assertion is made on seats in use, because the plan says so directly: "assert
 * on lanes free, not on the parked tasks looking calm."
 */
import { createPool } from "../src/db.js";
import {
  handoffFor, handoffMessage, lanesInUse, linkIsFresh, mintAuthLink,
  parkForAuth, resumeFromAuth, type RequestOrigin,
} from "../src/handoff.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s46-${Math.random().toString(36).slice(2, 7)}`;
const NOW = new Date("2026-09-10T09:00:00Z");
const FLOW = {
  provider: "Composio",
  authorizeUrl: "https://backend.composio.dev/oauth/start?flow=abc123",
  lifetimeMs: 10 * 60 * 1000,
};

async function main(): Promise<void> {
  let project = "";
  const tasks: string[] = [];
  try {
    project = (await pool.query<{ id: string }>(
      `INSERT INTO projects (slug,name,project_type,confidentiality)
       VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG])).rows[0].id;

    console.log("1. the link comes from the flow, never from content");
    const link = mintAuthLink(FLOW, NOW);
    link.provenance === "connection_flow" && link.url.startsWith("https://backend.composio.dev")
      ? ok("minting takes the flow and produces a link Jarvis will vouch for")
      : bad(`minted: ${JSON.stringify(link)}`);
    /*
     * There is no function taking a URL string and returning an AuthLink, which
     * is the mechanism. Asserted here as the shape of the module: the only
     * producer takes a ConnectionFlow.
     */
    let plaintextRefused = false;
    try {
      mintAuthLink({ ...FLOW, authorizeUrl: "http://backend.composio.dev/oauth/start" }, NOW);
    } catch {
      plaintextRefused = true;
    }
    plaintextRefused
      ? ok("and a plaintext sign-in page is refused — its destination is rewritable in transit")
      : bad("an http sign-in link was minted");

    console.log("");
    console.log("2. a 'reconnect your account' message produces no handoff");
    /*
     * THE PLAN'S OWN TEST. Reading a message that says reconnect your Google
     * account is a fact about the message.
     */
    for (const origin of ["message_content", "tool_result"] as RequestOrigin[]) {
      const d = handoffFor({ origin, link });
      d.send === false && d.asContent
        ? ok(`a request originating in ${origin.replace("_", " ")} lands as content, not a tappable link`)
        : bad(`A HANDOFF WAS SENT FOR ${origin}`);
    }
    handoffFor({ origin: "message_content", link }).send === false
      ? ok("even though the link itself is a perfectly genuine Composio one")
      : bad("a genuine link from an illegitimate origin was sent");
    /*
     * And both halves: the rule is not simply "never send".
     */
    const fromHim = handoffFor({ origin: "enrique", link });
    const fromTask = handoffFor({ origin: "approved_task", link });
    fromHim.send && fromTask.send
      ? ok("while a request from him, or from a task he approved, does send one")
      : bad("no handoff is ever sent, which is the rule switched off");

    console.log("");
    console.log("3. the message names the host, and follows it");
    const message = handoffMessage(link);
    message.includes("Composio") && message.includes("backend.composio.dev")
      ? ok(`it names the provider and the host: "${message.split("\\n").join(" / ")}"`)
      : bad(`message: ${message}`);
    /*
     * "Change the destination in the flow and the message changes with it - A
     * NAME THAT IS HARDCODED PROVES NOTHING." So the flow is changed and the
     * message has to follow.
     */
    const swapped = mintAuthLink({
      ...FLOW, authorizeUrl: "https://oauth.example-provider.test/start?flow=abc123",
    }, NOW);
    const swappedMessage = handoffMessage(swapped);
    swappedMessage.includes("oauth.example-provider.test")
      ? ok("changing the destination changes the host in the message")
      : bad(`the host is hardcoded: ${swappedMessage}`);
    !swappedMessage.includes("composio.dev")
      ? ok("and the old host is gone from it, so the label cannot reassure about a swap")
      : bad("A SWAPPED DESTINATION KEPT THE OLD HOST IN THE MESSAGE");
    handoffMessage(link, "Connections › pending").includes("console")
      ? ok("and the same handoff is reachable somewhere he navigated to himself")
      : bad("the console route is not offered");

    console.log("");
    console.log("4. parking releases the lane");
    const mk = async (title: string) => {
      const id = (await pool.query<{ id: string }>(
        `INSERT INTO tasks (project_id, title, state, priority, lane, lease_owner, lease_until)
         VALUES ($1,$2,'running','normal','heavy','worker-1', now() + interval '5 minutes')
         RETURNING id`, [project, title])).rows[0].id;
      tasks.push(id);
      return id;
    };
    const parked = [];
    for (let i = 0; i < 5; i += 1) parked.push(await mk(`${SLUG} awaiting auth ${i}`));
    const busyBefore = await lanesInUse(pool, "heavy");
    busyBefore >= 5 ? ok(`${busyBefore} heavy seats held while running`) : bad("the fixtures hold no seats");

    for (const id of parked) await parkForAuth(pool, { taskId: id, provider: "Composio", now: NOW });
    /*
     * "Park five tasks on auth -> THE QUEUE KEEPS RUNNING. Assert on lanes free,
     * not on the parked tasks looking calm." A parked task and a running one
     * look identical from the task row; the seat is the difference.
     */
    const busyAfter = await lanesInUse(pool, "heavy");
    busyAfter === busyBefore - 5
      ? ok(`all five seats came back: ${busyBefore} -> ${busyAfter}`)
      : bad(`seats held after parking: ${busyAfter}, was ${busyBefore}`);
    const held = Number((await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM tasks WHERE id = ANY($1::uuid[]) AND lease_owner IS NOT NULL`,
      [parked])).rows[0].n);
    held === 0 ? ok("and no parked task still owns a lease") : bad(`${held} parked tasks hold a lease`);
    const states = (await pool.query<{ state: string }>(
      `SELECT DISTINCT state FROM tasks WHERE id = ANY($1::uuid[])`, [parked])).rows.map((r) => r.state);
    states.length === 1 && states[0] === "waiting_for_user"
      ? ok("parked in a known state with a truthful reason, not left looking alive")
      : bad(`states: ${states.join(", ")}`);

    console.log("");
    console.log("5. resume from where it stopped, and never replay a dead link");
    const fresh = await resumeFromAuth(pool, { taskId: parked[0], link, now: NOW });
    fresh.resumed && !fresh.regenerated
      ? ok("a live link resumes without regenerating anything")
      : bad(`resume: ${JSON.stringify(fresh)}`);
    (await pool.query<{ state: string }>(
      `SELECT state FROM tasks WHERE id = $1`, [parked[0]])).rows[0].state === "queued"
      ? ok("re-queued rather than carried on in a seat it never left")
      : bad("the task was set running directly");

    const later = new Date(NOW.getTime() + FLOW.lifetimeMs + 60_000);
    !linkIsFresh(link, later) ? ok("past its lifetime the link is dead") : bad("the link never expires");
    let reminted = 0;
    const expired = await resumeFromAuth(pool, {
      taskId: parked[1], link, now: later,
      remint: () => { reminted += 1; return mintAuthLink(FLOW, later); },
    });
    expired.resumed && expired.regenerated && reminted === 1
      ? ok("so a late resume regenerates rather than replaying it")
      : bad(`expired resume: ${JSON.stringify(expired)}, reminted ${reminted}`);
    /*
     * "If the flow cannot be regenerated, say so and issue a fresh handoff
     * instead of failing quietly." A silent failure here looks like Jarvis's
     * fault to him, because the last thing he did was sign in successfully.
     */
    const cannot = await resumeFromAuth(pool, { taskId: parked[2], link, now: later, remint: null });
    !cannot.resumed && cannot.why.includes("fresh handoff")
      ? ok(`and one that cannot be regenerated says so: "${cannot.why}"`)
      : bad(`unregenerable resume: ${JSON.stringify(cannot)}`);
    (await pool.query<{ state: string }>(
      `SELECT state FROM tasks WHERE id = $1`, [parked[2]])).rows[0].state === "waiting_for_user"
      ? ok("leaving it parked rather than half-resumed")
      : bad("a failed resume moved the task anyway");

    console.log("");
    console.log("6. resuming something that was never parked");
    const running = await mk(`${SLUG} busy`);
    const wrong = await resumeFromAuth(pool, { taskId: running, link, now: NOW });
    !wrong.resumed
      ? ok("a task that is not waiting for him is not dragged into the queue by a stray signal")
      : bad("a running task was re-queued by an auth signal");
  } finally {
    if (tasks.length) await pool.query(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [tasks]);
    if (project) await pool.query(`DELETE FROM projects WHERE id = $1`, [project]);
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

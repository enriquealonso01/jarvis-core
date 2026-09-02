/**
 * S14 — is a whole engineering run legible from a phone? (plan S14)
 *
 * The plan's Test section is specific: watch a complete S6 run from the console
 * with no terminal access, kill SSE mid-run and see the banner, then reconnect
 * and catch up without losing events, and never render `0` where the answer is
 * unknown.
 *
 * So this runs a real S6 workflow run — the real runner, the fake harness, the
 * real API — and watches it from a real browser at 375px while it happens. The
 * page is never reloaded during the run: everything asserted after the first
 * paint arrived over SSE, which is the only way to tell a live view from a view
 * that happens to be fresh.
 *
 * Killing the connection is done with the browser's own offline switch rather
 * than by stopping the API, because stopping the API would also stop the run,
 * and then "no events were lost" would be true for the boring reason.
 *
 *   node scripts/s14-live-detail-test.mjs
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, "../jarvis-control-center/out");
const PORT = 8093;
const BASE = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 375, height: 667 };

const EDGE = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m, e, a) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${e}`);
  console.log(`        actual:   ${a}`);
  fail += 1;
};
const check = (m, e, a) => (String(e) === String(a) ? ok(m) : bad(m, e, a));
const truthy = (m, a) => (a ? ok(m) : bad(m, "truthy", a));

const COMPOSE = ["compose", "-f", "deploy/compose.dev.yaml"];
async function sql(text) {
  const { stdout } = await run(
    "docker",
    [...COMPOSE, "exec", "-T", "postgres", "psql", "-U", "jarvis", "-d", "jarvis", "-tAX", "-c", text],
    { cwd: ROOT, maxBuffer: 1 << 24 },
  );
  return stdout.trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a page-side predicate rather than sleeping at it. */
async function until(page, fn, arg, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await page.evaluate(fn, arg)) return true;
    if (Date.now() > deadline) {
      console.log(`        (timed out after ${ms}ms waiting for ${what})`);
      return false;
    }
    await sleep(250);
  }
}

async function main() {
  if (!EDGE) throw new Error("no Chromium-family browser found to drive");
  if (!fs.existsSync(path.join(OUT, "index.html"))) {
    throw new Error(`no console export at ${OUT} — run \`pnpm build\` in jarvis-control-center`);
  }

  const startServer = () =>
    spawn(
      process.execPath,
      ["scripts/console-serve.mjs", "--port", String(PORT), "--out", OUT],
      { cwd: ROOT, stdio: "ignore" },
    );
  let server = startServer();
  const browser = await chromium.launch({ executablePath: EDGE });
  let runner = null;

  try {
    for (let i = 0; i < 40; i += 1) {
      try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* not up yet */ }
      await sleep(250);
    }

    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await page.goto(`${BASE}/login/`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', process.env.JARVIS_OPERATOR_EMAIL ?? "dev@jarvis.local");
    await page.fill('input[type="password"]', process.env.JARVIS_OPERATOR_PASSWORD ?? "dev-password-1234");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 });

    // A clean queue, so the runner claims the task under test and not a leftover.
    await sql(`UPDATE tasks SET state='cancelled', lease_owner=NULL, lease_until=NULL
               WHERE lane='heavy' AND state IN ('queued','preparing','running')`);
    const taskId = (await sql(
      `INSERT INTO tasks (project_id,title,objective,state,lane,priority)
       SELECT id,'S14 watch this run from a phone',
              'Fix the failing test in the cart total.','queued','heavy','normal'
       FROM projects WHERE slug='dev-sandbox' RETURNING id`,
    )).match(/[0-9a-f-]{36}/)?.[0];
    truthy("a task is queued for the heavy lane", Boolean(taskId));

    console.log("\n########## watching a real S6 run, live ##########\n");

    await page.goto(`${BASE}/work/?task=${taskId}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="live-ok"]', { timeout: 15000 });
    ok("the console reports the stream as live before anything happens");

    const before = await page.evaluate(() =>
      document.querySelectorAll('[data-testid="event-timeline"] li').length);

    // Start the run. From here the page is NOT reloaded: everything below
    // arrived over the stream.
    runner = spawn(
      "docker",
      [...COMPOSE, "run", "--rm", "--no-deps", "-T",
        "-e", "RUNNER_ONCE=1", "-e", "RUNNER_IDLE_EXIT_MS=10000",
        "-e", "JARVIS_HARNESS=fake:workflow", "-e", "JARVIS_FAKE_WORKFLOW=full",
        "-e", "JARVIS_HEARTBEAT_MS=1500", "-e", "JARVIS_FAKE_PHASE_MS=1200",
        "runner"],
      { cwd: ROOT, stdio: "ignore" },
    );

    const gotEvents = await until(
      page,
      (n) => document.querySelectorAll('[data-testid="event-timeline"] li').length > n,
      before,
      60000,
      "events to arrive over SSE",
    );
    truthy("events appear without the page being reloaded", gotEvents);

    const sawTool = await until(
      page,
      () => [...document.querySelectorAll('[data-testid="event-timeline"] li')]
        .some((li) => li.textContent.includes("tool")),
      null,
      60000,
      "a tool event",
    );
    truthy("and they include what the harness actually ran, not just that it ran", sawTool);

    const sawPhase = await until(
      page,
      () => [...document.querySelectorAll('[data-testid="event-timeline"] li')]
        .some((li) => li.textContent.includes("phase")),
      null,
      60000,
      "a phase event",
    );
    truthy("the named phases arrive too", sawPhase);

    // ------------------------------------------------- kill the connection
    console.log("\n--- the connection drops mid-run ---");
    const duringOutage = await page.evaluate(() =>
      document.querySelectorAll('[data-testid="event-timeline"] li').length);

    /*
     * Kill the connection by killing the server the page is talking to, not with
     * Playwright's offline switch: Chromium's network emulation does not apply
     * to loopback, so setOffline left the SSE stream happily connected and the
     * banner never fired — the test reported a missing feature that was working.
     *
     * The API and the runner are untouched, so the run keeps going and the
     * events it produces during the outage are exactly the ones that must not be
     * lost.
     */
    server.kill();
    await sleep(500);

    const banner = await until(
      page,
      () => Boolean(document.querySelector('[data-testid="live-banner"]')),
      null,
      15000,
      "the paused banner",
    );
    truthy("the page says so rather than looking merely quiet", banner);
    const bannerText = await page.textContent('[data-testid="live-banner"]').catch(() => "");
    truthy("and says what it means", (bannerText ?? "").includes("Live updates paused"));

    // The run keeps going while the page cannot see it.
    await sleep(6000);
    server = startServer();
    for (let i = 0; i < 40; i += 1) {
      try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* not up yet */ }
      await sleep(250);
    }

    const recovered = await until(
      page,
      () => Boolean(document.querySelector('[data-testid="live-ok"]')),
      null,
      30000,
      "the stream to come back",
    );
    truthy("it reconnects on its own", recovered);

    const caughtUp = await until(
      page,
      (n) => document.querySelectorAll('[data-testid="event-timeline"] li').length > n,
      duringOutage,
      30000,
      "the events from the outage",
    );
    truthy("and the events from the outage are there, not lost", caughtUp);

    // ------------------------------------------------- the run finishes
    console.log("\n--- the run finishes ---");
    /*
     * Wait for the RUN to finish first, in the database, then check the page.
     * The first version of this searched the whole body for the word
     * "succeeded" — which is in the task list beside every other finished task,
     * so it passed while the run under test was still going. An assertion that
     * matches the wrong element is the same as no assertion.
     */
    let dbState = "";
    for (let i = 0; i < 240; i += 1) {
      dbState = await sql(`SELECT state FROM tasks WHERE id='${taskId}'`);
      if (["succeeded", "failed_terminal", "waiting_for_user", "cancelled"].includes(dbState)) break;
      await sleep(500);
    }
    check("the run reached a terminal state", "succeeded", dbState);

    const finished = await until(
      page,
      (want) => document.querySelector('[data-testid="detail-state"]')?.getAttribute("data-state")
        === want,
      dbState,
      30000,
      "the detail pane to show the terminal state",
    );
    truthy("and this task's own badge shows it, with no reload", finished);

    const dbTools = Number(await sql(
      `SELECT count(*) FROM task_events WHERE task_id='${taskId}' AND type='tool'`));
    const dbPhases = Number(await sql(
      `SELECT count(*) FROM task_events WHERE task_id='${taskId}' AND type='phase'`));
    console.log(`  db: state=${dbState} tool events=${dbTools} phase events=${dbPhases}`);
    truthy("the run really did record tool calls, not just render them", dbTools > 0);
    truthy("and its phases", dbPhases > 0);

    // What the page shows must match what happened, or it is a decoration that
    // happens to be moving.
    const allShown = await until(
      page,
      (n) => [...document.querySelectorAll('[data-testid="event-timeline"] li')]
        .filter((li) => li.textContent.includes("tool")).length >= n,
      dbTools,
      20000,
      "every tool call to reach the page",
    );
    const shownTools = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="event-timeline"] li')]
        .filter((li) => li.textContent.includes("tool")).length);
    truthy(`the timeline shows EVERY tool call (${shownTools} of ${dbTools})`, allShown);

    // ------------------------------------------------- legibility
    console.log("\n--- legible on a phone ---");
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("nothing overflows the 375px viewport", 0, overflow);

    const sections = await page.evaluate(() =>
      [...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")));
    truthy("the event timeline is on the page", sections.includes("event-timeline"));

    const text = await page.textContent("body");
    truthy("the branch it worked on is shown", /jarvis\/task-/.test(text ?? ""));

    // ------------------------------------------------- unknown, never zero
    console.log("\n--- unknown renders unknown ---");
    const fresh = (await sql(
      `INSERT INTO tasks (project_id,title,objective,state,lane,priority)
       SELECT id,'S14 nothing has happened yet','x','captured','heavy','normal'
       FROM projects WHERE slug='dev-sandbox' RETURNING id`,
    )).match(/[0-9a-f-]{36}/)?.[0];
    await page.goto(`${BASE}/work/?task=${fresh}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="timing-unknown"]', { timeout: 15000 });
    const unknownText = await page.textContent('[data-testid="timing-unknown"]');
    truthy("a task with nothing measured says unknown", (unknownText ?? "").includes("unknown"));
    const zeros = await page.evaluate(() =>
      [...document.querySelectorAll(".stat-value")].filter((e) => e.textContent.trim() === "0s").length);
    check("and does not claim it took 0s", 0, zeros);

    console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  } finally {
    runner?.kill();
    await browser.close().catch(() => undefined);
    server.kill();
  }
}

main()
  .catch((err) => {
    console.error(err);
    fail += 1;
    console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  })
  .finally(() => process.exit(fail === 0 ? 0 : 1));

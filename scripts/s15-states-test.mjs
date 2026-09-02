/**
 * S15 — force each state and check the page says which one it is. (plan S15)
 *
 * The plan is blunt about the standard: "A state you cannot force is a state you
 * have not implemented." So none of these are simulated by passing a prop —
 * every one is provoked the way it happens in the world: empty the queue, kill
 * the API, expire the session, back-date the data.
 *
 * The failure this is guarding against is the one the plan names: a blank panel
 * is indistinguishable from a broken one, and after the second time it is
 * broken, every blank panel is assumed to be a bug.
 *
 *   node scripts/s15-states-test.mjs
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
const PORT = 8100;
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = { width: 375, height: 667 };

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COMPOSE = ["compose", "-f", "deploy/compose.dev.yaml"];
async function sql(text) {
  const { stdout } = await run(
    "docker",
    [...COMPOSE, "exec", "-T", "postgres", "psql", "-U", "jarvis", "-d", "jarvis", "-tAX", "-c", text],
    { cwd: ROOT, maxBuffer: 1 << 24 },
  );
  return stdout.trim();
}

/** What state is the panel reporting, and does it say anything useful? */
async function panel(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="panel-state"]');
    if (!el) return null;
    return {
      state: el.getAttribute("data-state"),
      text: (el.textContent ?? "").trim(),
      live: el.getAttribute("aria-live"),
      role: el.getAttribute("role"),
    };
  });
}

async function main() {
  if (!EDGE) throw new Error("no Chromium-family browser found to drive");
  const startServer = () =>
    spawn(process.execPath, ["scripts/console-serve.mjs", "--port", String(PORT), "--out", OUT], {
      cwd: ROOT,
      stdio: "ignore",
    });
  let server = startServer();
  const browser = await chromium.launch({ executablePath: EDGE });

  try {
    for (let i = 0; i < 40; i += 1) {
      try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* not up */ }
      await sleep(250);
    }
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    await page.goto(`${BASE}/login/`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', process.env.JARVIS_OPERATOR_EMAIL ?? "dev@jarvis.local");
    await page.fill('input[type="password"]', process.env.JARVIS_OPERATOR_PASSWORD ?? "dev-password-1234");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 });

    console.log("########## forcing each state on /queue ##########\n");

    // ------------------------------------------------------------- empty
    console.log("=== empty: nothing queued, nothing recent ===");
    // Every task, not just the live ones. The first version excluded rows that
    // were already `cancelled`, so two hundred of them stayed inside the
    // 24-hour "recently completed" window and the queue was never empty — the
    // test reported a missing empty state that was working.
    const parked = await sql(
      `UPDATE tasks SET state = CASE WHEN state IN ('succeeded','failed_terminal','cancelled')
                                     THEN state ELSE 'cancelled' END,
              lease_owner=NULL, lease_until=NULL,
              updated_at = now() - interval '3 days'
       RETURNING 1`,
    );
    await page.goto(`${BASE}/queue/`, { waitUntil: "networkidle" });
    await sleep(1200);
    let p = await panel(page);
    truthy("the page reports a state rather than a blank panel", p);
    check("it is `empty`", "empty", p?.state);
    truthy(
      "and it says Jarvis is available, in the plan's own words",
      (p?.text ?? "").includes("No work is currently queued. Jarvis is available."),
    );
    check("announced to a screen reader, not only recoloured", "polite", p?.live);
    console.log(`  (parked ${parked.split("\n").filter(Boolean).length} tasks to force it)`);

    // ------------------------------------------------------------- content
    console.log("\n=== healthy: there is work, so no panel at all ===");
    await sql(
      `INSERT INTO tasks (project_id,title,objective,state,lane,priority)
       SELECT id,'S15 a real queued task','x','queued','heavy','normal'
       FROM projects WHERE slug='dev-sandbox'`,
    );
    await page.goto(`${BASE}/queue/`, { waitUntil: "networkidle" });
    await sleep(1200);
    p = await panel(page);
    check("no state panel when there is content to show", null, p);
    truthy(
      "and the task itself is on the page",
      (await page.textContent("body"))?.includes("S15 a real queued task"),
    );

    // ------------------------------------------------------------- offline
    console.log("\n=== offline: the API cannot be reached ===");
    server.kill();
    await sleep(500);
    // The page is already loaded; only its fetches fail. That is what an outage
    // looks like from a phone that already had the tab open.
    await page.click("text=Refresh").catch(() => undefined);
    // A connection to a dead port does not always fail instantly on Windows, so
    // poll for the state rather than guessing a sleep long enough.
    for (let i = 0; i < 40; i += 1) {
      p = await panel(page);
      if (p?.state === "offline") break;
      await sleep(500);
    }
    check("it is `offline`", "offline", p?.state);
    truthy(
      "and it says the page is showing nothing, not zero",
      (p?.text ?? "").toLowerCase().includes("nothing, not zero"),
    );
    server = startServer();
    for (let i = 0; i < 40; i += 1) {
      try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* not up */ }
      await sleep(250);
    }

    // --------------------------------------------------- permission denied
    console.log("\n=== permission denied: the session is revoked mid-visit ===");
    await sql("DELETE FROM sessions");
    await page.goto(`${BASE}/queue/`, { waitUntil: "networkidle" });
    await sleep(1500);
    p = await panel(page);
    // The page may also bounce to /login. Either is a defensible answer; what is
    // not defensible is a blank queue that looks like no work.
    const url = page.url();
    if (url.includes("login")) {
      ok("it sends you to sign in rather than showing an empty queue");
    } else {
      check("it is `permission_denied`", "permission_denied", p?.state);
      truthy("and offers a way back in", (p?.text ?? "").toLowerCase().includes("sign in"));
    }

    console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  } finally {
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

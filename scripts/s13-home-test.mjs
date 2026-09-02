/**
 * S13 — does Home actually lead with work? (plan S13)
 *
 * The plan's Debug section says what to do when Home "still feels like a status
 * page": **count what is above the fold on a 375px viewport**. A feeling is not
 * testable and a screenshot I look at myself is not evidence, so this measures
 * it — a real browser, a real phone viewport, real geometry from
 * getBoundingClientRect, against the real API with real rows in the database.
 *
 * It uses playwright-core driving the Edge already on this machine rather than
 * downloading a browser: the assertion is about layout at a width, and any
 * Chromium answers that identically.
 *
 * Two worlds are measured, because the plan asks for both:
 *   - a heavy task running  -> the first screenful is that task
 *   - nothing running       -> Home reads calm, not broken
 *
 *   node scripts/s13-home-test.mjs
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
const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;

// iPhone SE / iPhone 8 — the smallest phone still in real use, and the width the
// plan names. If it works here it works on every larger phone.
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

/** Where is this element, in page coordinates, and how tall? */
async function box(page, testid) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY, height: r.height };
  }, testid);
}

/**
 * Everything with text that is inside the first screenful, top to bottom.
 * This is the "count what is above the fold" the plan asks for, done by the
 * machine so the answer does not depend on how generous I am feeling.
 */
async function aboveTheFold(page, foldHeight) {
  return page.evaluate((fold) => {
    const out = [];
    for (const el of document.querySelectorAll("[data-testid]")) {
      const r = el.getBoundingClientRect();
      const top = r.top + window.scrollY;
      // Visually hidden, not above the fold. The S15 skip link is parked at
      // left:-9999px until it takes focus, and it still has a height — so it
      // counted as the first thing on the page and this suite reported a
      // reordering that had not happened.
      const offscreen = r.right <= 0 || r.left >= window.innerWidth;
      if (top < fold && r.height > 0 && !offscreen) {
        out.push({ id: el.getAttribute("data-testid"), top: Math.round(top), height: Math.round(r.height) });
      }
    }
    return out.sort((a, b) => a.top - b.top);
  }, foldHeight);
}

async function main() {
  if (!EDGE) throw new Error("no Chromium-family browser found to drive");
  if (!fs.existsSync(path.join(OUT, "index.html"))) {
    throw new Error(`no console export at ${OUT} — run \`pnpm build\` in jarvis-control-center`);
  }

  const server = spawn(
    process.execPath,
    ["scripts/console-serve.mjs", "--port", String(PORT), "--out", OUT],
    { cwd: ROOT, stdio: "ignore" },
  );
  const browser = await chromium.launch({ executablePath: EDGE });

  try {
    // Wait for the static server rather than sleeping at it.
    for (let i = 0; i < 40; i += 1) {
      try {
        const r = await fetch(`${BASE}/`);
        if (r.ok) break;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
    const page = await context.newPage();

    // Log in through the real form, so the session cookie is the real one.
    await page.goto(`${BASE}/login/`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', process.env.JARVIS_OPERATOR_EMAIL ?? "dev@jarvis.local");
    await page.fill('input[type="password"]', process.env.JARVIS_OPERATOR_PASSWORD ?? "dev-password-1234");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 });

    // ================================================================ world 1
    console.log("########## a heavy task is running ##########\n");

    await sql(`UPDATE tasks SET state='cancelled', lease_owner=NULL, lease_until=NULL
               WHERE lane='heavy' AND state IN ('queued','preparing','running')`);
    const running = await sql(
      `INSERT INTO tasks (project_id,title,objective,state,lane,priority,branch,harness,
                          lease_owner,lease_until,heartbeat_at)
       SELECT id,'Fix the checkout total on alpha web','x','running','heavy','normal',
              'jarvis/task-s13','claude','dev-heavy-1',now()+interval '5 minutes',now()
       FROM projects WHERE slug='alpha-web' RETURNING id`,
    );
    truthy("a heavy task is running in the database", /[0-9a-f-]{36}/.test(running));
    // Two more queued, one of them on the system lane, so the lane filter has
    // something to filter.
    await sql(`INSERT INTO tasks (project_id,title,objective,state,lane,priority)
               SELECT id,'S13 queued engineering task','x','queued','heavy','normal'
               FROM projects WHERE slug='alpha-web'`);
    await sql(`INSERT INTO tasks (project_id,title,objective,state,lane,priority)
               SELECT id,'S13 routine maintenance sweep','x','queued','system','background'
               FROM projects WHERE slug='alpha-web'`);

    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="running-title"]', { timeout: 15000 });

    const fold = VIEWPORT.height;
    const seen = await aboveTheFold(page, fold);
    console.log(`  above the fold at ${VIEWPORT.width}x${fold}:`);
    for (const s of seen) console.log(`    ${String(s.top).padStart(4)}px  ${s.id}`);
    console.log();

    const ids = seen.map((s) => s.id);
    const nowBox = await box(page, "now");
    const titleBox = await box(page, "running-title");

    truthy("the running task's own title is above the fold", titleBox && titleBox.bottom <= fold);
    // Anything from the build-progress component, not just its outer element:
    // S15 gave the bar itself a testid, and the assertion started reporting the
    // bar's own inner element as if it were a section that had jumped the queue.
    check(
      "and it is the first thing after the build bar",
      "now",
      ids.find((i) => !i.startsWith("build-")),
    );
    truthy("the Now card starts in the top half of the screen", nowBox && nowBox.top < fold / 2);

    // The Done when, measured rather than asserted.
    const diskBox = await box(page, "disk-pct");
    truthy("the disk percentage is NOT above the fold", !diskBox || diskBox.top >= fold);
    const healthBox = await box(page, "health-strip");
    truthy(
      "and health sits below the work, not above it",
      healthBox && nowBox && healthBox.top > nowBox.top,
    );

    // Health collapsed to a strip: one line, not a grid of tiles.
    check("health is one strip, not a panel", true, (healthBox?.height ?? 999) <= 56);
    await page.click('[data-testid="health-strip"] summary');
    const openBox = await box(page, "health-strip");
    truthy("and it opens when asked", (openBox?.height ?? 0) > (healthBox?.height ?? 0) + 100);
    const diskOpen = await box(page, "disk-pct");
    truthy("the disk percentage is in there when you open it", diskOpen && diskOpen.height > 0);
    await page.click('[data-testid="health-strip"] summary');

    // The queue, and the system lane.
    const queueRows = await page.$$eval('[data-testid="queue-list"] [data-lane]', (els) =>
      els.map((e) => ({ lane: e.getAttribute("data-lane"), title: e.textContent ?? "" })),
    );
    truthy("the queue lists real tasks", queueRows.length > 0);
    check("no system-lane task is shown by default", 0, queueRows.filter((r) => r.lane === "system").length);
    truthy(
      "and the engineering task IS shown",
      queueRows.some((r) => r.title.includes("S13 queued engineering task")),
    );
    await page.click('[data-testid="system-lane-toggle"]');
    const withSystem = await page.$$eval('[data-testid="queue-list"] [data-lane]', (els) =>
      els.map((e) => e.getAttribute("data-lane")),
    );
    truthy("the toggle reveals it", withSystem.includes("system"));

    const queueBox = await box(page, "queue");
    const needsBox = await box(page, "needs-you");
    truthy("the queue comes before health", queueBox && healthBox && queueBox.top < healthBox.top);
    truthy("so does what needs Enrique", needsBox && healthBox && needsBox.top < healthBox.top);

    // Reachability: all three are REACHED within one thumb-flick. Measured on
    // where the card starts, not where it ends — "Needs you" is as tall as the
    // number of things needing him, and a card that is long because there is a
    // lot to do is not a layout failure.
    truthy(
      "running, queue and needs-you are all reached within 1.5 screens",
      needsBox && needsBox.top <= fold * 1.5,
    );
    // ...and it is capped, so one bad day does not bury the rest of the page.
    const needsRows = await page.$$eval('[data-testid="needs-you"] .needs-row', (e) => e.length);
    truthy("the needs-you list is capped rather than unbounded", needsRows <= 6);

    // ================================================================ world 2
    console.log("\n########## nothing is running ##########\n");

    await sql(`UPDATE tasks SET state='cancelled', lease_owner=NULL, lease_until=NULL
               WHERE lane IN ('heavy','system') AND state IN ('queued','preparing','running')`);
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="now-empty"]', { timeout: 15000 });

    const calm = await aboveTheFold(page, fold);
    console.log(`  above the fold at ${VIEWPORT.width}x${fold}:`);
    for (const s of calm) console.log(`    ${String(s.top).padStart(4)}px  ${s.id}`);
    console.log();

    const emptyText = await page.textContent('[data-testid="now-empty"]');
    truthy("the empty state says plainly that nothing is running", emptyText.includes("Nothing running"));

    /*
     * "Calm rather than broken" is the plan's wording, and what makes an empty
     * state read broken is alarm colour.
     *
     * Scoped to Home's OWN content, not the persistent status bar. The dev box
     * genuinely has fifteen unconnected credentials and an open incident, and
     * the status bar saying so in amber is correct — a Home that painted that
     * calm would be lying, which is the opposite of the thing being tested. What
     * must not be alarming is the page's own idle state.
     */
    const alarming = await page.evaluate((foldPx) => {
      const WARN = ["rgb(251, 191, 36)", "rgb(248, 113, 113)"]; // --warn, --err
      const out = [];
      const root = document.querySelector("main.wrap") ?? document.body;
      for (const el of root.querySelectorAll("*")) {
        // The status bar and the header are on every page, and both are
        // reporting real conditions of this box — an open incident, fifteen
        // unconnected credentials, unread alerts. Home is not allowed to paint
        // those calm. What is scoped here is the page's own content.
        if (el.closest(".statusbar") || el.closest(".header")) continue;
        const r = el.getBoundingClientRect();
        if (r.top + window.scrollY >= foldPx || r.height === 0) continue;
        if (!el.textContent || !el.textContent.trim()) continue;
        const c = getComputedStyle(el);
        if (WARN.includes(c.color)) {
          out.push(`${el.tagName}.${el.className}: ${el.textContent.trim().slice(0, 40)}`);
        }
      }
      return out;
    }, fold);
    check("nothing in Home's own content is drawn in an alarm colour", "", alarming.join(" | "));

    /*
     * The other half of that, and the one that keeps it honest: calm must come
     * from there being nothing wrong, never from hiding what is. The dev box HAS
     * problems, so they must still be reported.
     */
    const statusbarText = await page.textContent(".statusbar");
    const needsCount = await page.textContent('[data-testid="needs-you"] .badge, [data-testid="needs-you"] span');
    truthy(
      "the real problems are still reported, not smoothed away",
      /Incident|Degraded/i.test(statusbarText ?? "") || Number(needsCount) > 0,
    );

    const calmIds = calm.map((s) => s.id);
    truthy("the Now card is still what leads", calmIds.includes("now"));
    truthy("the queue's empty state is calm too", calmIds.includes("queue"));
    const diskCalm = await box(page, "disk-pct");
    truthy("and disk is still nowhere near the top", !diskCalm || diskCalm.top >= fold);

    // A rendering check a human would otherwise have to do on a phone: nothing
    // overflows the 375px width. A horizontal scrollbar is what "looks broken on
    // a real device but fine on a desktop" actually is.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("nothing overflows the 375px viewport", 0, overflow);

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

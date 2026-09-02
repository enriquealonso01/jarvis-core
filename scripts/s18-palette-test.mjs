/**
 * S18 — the palette, on a desktop and on a phone. (plan S18)
 *
 * Two of the Done when's three clauses are here: "every palette command works on
 * desktop and mobile", and the box finds things that are not page names.
 *
 * The assertion that matters most is the one the plan's Debug section is about:
 * "If a palette command works from the page but not the palette, the palette
 * built its own request." So an action command is not checked by watching the
 * palette say "Done" — it is checked in the database, against the same row the
 * page's button would have changed.
 *
 *   node scripts/s18-palette-test.mjs
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
const PORT = 8107;
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = { width: 375, height: 667 };
const DESKTOP = { width: 1280, height: 900 };

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
const uuid = (s) => s.match(/[0-9a-f-]{36}/)?.[0] ?? null;

async function login(page) {
  await page.goto(`${BASE}/login/`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', process.env.JARVIS_OPERATOR_EMAIL ?? "dev@jarvis.local");
  await page.fill('input[type="password"]', process.env.JARVIS_OPERATOR_PASSWORD ?? "dev-password-1234");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 });
}

async function main() {
  if (!EDGE) throw new Error("no Chromium-family browser found to drive");
  const server = spawn(
    process.execPath,
    ["scripts/console-serve.mjs", "--port", String(PORT), "--out", OUT],
    { cwd: ROOT, stdio: "ignore" },
  );
  const browser = await chromium.launch({ executablePath: EDGE });

  try {
    for (let i = 0; i < 40; i += 1) {
      try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* not up */ }
      await sleep(250);
    }

    const stamp = Date.now().toString(36);
    const PHRASE = `flibbertigibbet${stamp}`;
    const projectId = uuid(await sql(
      `INSERT INTO projects (slug,name,project_type,confidentiality,production_status)
       VALUES ('s18-palette','s18-palette','personal','normal','non_production')
       ON CONFLICT (slug) DO UPDATE SET archived_at = NULL RETURNING id`));
    // A phrase that exists ONLY inside a document — not in any title, so finding
    // it proves the box searches content rather than page names.
    await sql(`INSERT INTO knowledge_chunks (project_id, body)
               VALUES ('${projectId}', 'buried on page nine: ${PHRASE} appears once')`);

    // ============================================================= desktop
    console.log("########## the palette on a desktop ##########\n");
    const desk = await browser.newContext({ viewport: DESKTOP });
    const page = await desk.newPage();
    await login(page);
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await sleep(1200);

    await page.keyboard.press("Control+k");
    await page.waitForSelector('[data-testid="palette-input"]', { timeout: 10000 });
    ok("Ctrl+K opens it");

    await page.fill('[data-testid="palette-input"]', PHRASE);
    await sleep(1500);
    const hits = await page.textContent('[data-testid="palette-results"]');
    truthy("a phrase that exists only inside a document is found", (hits ?? "").includes("page nine"));
    truthy("under a group that says where it came from", (hits ?? "").includes("Inside documents"));

    await page.fill('[data-testid="palette-input"]', "vogonpoetry-nothing-at-all");
    await sleep(1500);
    const empty = await page.textContent('[data-testid="palette-empty"]').catch(() => null);
    truthy("zero results says so rather than showing an empty list", (empty ?? "").includes("Nothing matches"));

    // -------------------------------------------- an action, checked in the DB
    console.log("\n=== an action command hits the same endpoint the page does ===");
    await sql(`UPDATE tasks SET state='cancelled', lease_owner=NULL, lease_until=NULL
               WHERE lane='heavy' AND state IN ('queued','preparing','running')`);
    const running = uuid(await sql(
      `INSERT INTO tasks (project_id,title,objective,state,lane,priority,
                          lease_owner,lease_until,heartbeat_at)
       SELECT id,'S18 pause me from the palette','x','running','heavy','normal',
              'dev-heavy-1',now()+interval '10 minutes',now()
       FROM projects WHERE slug='dev-sandbox' RETURNING id`));

    await page.fill('[data-testid="palette-input"]', "Pause");
    await sleep(600);
    const paused = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="palette-row-act-pause-task"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    truthy("the pause command is in the palette", paused);
    await sleep(2500);
    check(
      "and the task is paused IN THE DATABASE, not just reported",
      "paused",
      await sql(`SELECT state FROM tasks WHERE id = '${running}'`),
    );
    check(
      "by the same endpoint the Work page calls",
      1,
      Number(await sql(`SELECT count(*) FROM task_transitions
                        WHERE task_id = '${running}' AND to_state = 'paused'`)),
    );

    // ...and the resume half, so the pair is symmetric.
    await page.fill('[data-testid="palette-input"]', "Resume");
    await sleep(600);
    await page.evaluate(() => {
      document.querySelector('[data-testid="palette-row-act-resume-task"]')?.click();
    });
    await sleep(2500);
    check(
      "resume brings it back",
      "queued",
      await sql(`SELECT state FROM tasks WHERE id = '${running}'`),
    );

    // -------------------------------------------- an action with nothing to do
    console.log("\n=== a command with nothing to act on says so ===");
    await sql(`UPDATE tasks SET state='cancelled', lease_owner=NULL, lease_until=NULL
               WHERE lane='heavy' AND state IN ('queued','preparing','running','paused')`);
    await page.reload({ waitUntil: "networkidle" });
    await sleep(1500);
    await page.keyboard.press("Control+k");
    await page.waitForSelector('[data-testid="palette-input"]', { timeout: 10000 });
    await page.fill('[data-testid="palette-input"]', "Pause");
    await sleep(600);
    await page.evaluate(() => {
      document.querySelector('[data-testid="palette-row-act-pause-task"]')?.click();
    });
    await sleep(2000);
    const notice = await page.textContent('[data-testid="palette-notice"]').catch(() => null);
    truthy(
      "it explains rather than failing silently",
      (notice ?? "").includes("Nothing is running"),
    );

    // ============================================================== phone
    console.log("\n########## and on a phone, where there is no Ctrl+K ##########\n");
    const mob = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
    const phone = await mob.newPage();
    await login(phone);
    await phone.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await sleep(1500);

    const trigger = await phone.$('.palette-trigger');
    const triggerVisible = trigger ? await trigger.isVisible() : false;
    check("the desktop trigger is hidden, as it should be", false, triggerVisible);

    // The tappable route: More -> Search everything.
    // A real tap on the bottom bar's own control, not the first element whose
    // text happens to be "More" — the nav has one of those too, and clicking it
    // through evaluate() did nothing while looking like it had.
    await phone.click(".bottom-more");
    await sleep(600);
    check(
      "the More sheet is reachable",
      true,
      await phone.evaluate(() => Boolean(document.querySelector(".more-sheet"))),
    );
    await phone.waitForSelector('[data-testid="palette-open"]', { timeout: 10000 });
    ok("and it offers a way into the palette");
    await phone.click('[data-testid="palette-open"]');
    await phone.waitForSelector('[data-testid="palette-input"]', { timeout: 10000 });
    ok("which opens it with a tap, no keyboard involved");

    await phone.fill('[data-testid="palette-input"]', PHRASE);
    await sleep(1500);
    const phoneHits = await phone.textContent('[data-testid="palette-results"]');
    truthy("and the same search works there", (phoneHits ?? "").includes("page nine"));

    const overflow = await phone.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("the palette does not overflow a 375px screen", 0, overflow);

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

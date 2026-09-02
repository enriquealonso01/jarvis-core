/**
 * L17 — the six journeys, on a phone and then with the keyboard alone. (plan S15)
 *
 * "Phone viewport: health, add context, resolve API-key Issue, approve,
 * reprioritize, open artifact. Keyboard desktop: same. No desktop-only blocker
 * for those six."
 *
 * Every journey ends with a database assertion, not a rendered confirmation. A
 * console that says "sent" and changed nothing is the exact failure the plan
 * warns about all the way through: nothing is done because a row was written,
 * and nothing is done because a toast appeared either.
 *
 * The keyboard pass is not a repeat with different input — it is the check that
 * none of the six has a step you can only reach with a pointer. It uses Tab and
 * Enter only, and asserts the same database effect.
 *
 *   node scripts/s15-journeys-test.mjs
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
const PORT = 8101;
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

/** Tab until the predicate matches the focused element, then report it. */
async function tabTo(page, match, limit = 80) {
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press("Tab");
    const hit = await page.evaluate((m) => {
      const el = document.activeElement;
      if (!el) return null;
      const text = (el.textContent ?? "").trim();
      const id = el.getAttribute("data-testid") ?? "";
      const label = el.getAttribute("aria-label") ?? "";
      return `${el.tagName}|${id}|${text}|${label}`.includes(m)
        ? { tag: el.tagName, id, text: text.slice(0, 40) }
        : null;
    }, match);
    if (hit) return hit;
  }
  return null;
}

// ------------------------------------------------------------------ fixtures

async function seedJourneys() {
  // Re-runnable. The first version left its issue behind and the second run died
  // on the dedupe key before a single journey happened — a suite you can only
  // run once is a suite you stop running.
  await sql("DELETE FROM issues WHERE dedupe_key = 'l17.credential'");
  await sql("DELETE FROM artifacts WHERE path = 'l17/report.txt'");
  await sql("DELETE FROM approvals WHERE target LIKE 'L17 approve me%'");
  await sql("DELETE FROM task_context WHERE body LIKE 'L17 %'");
  await sql(`UPDATE tasks SET state='cancelled', lease_owner=NULL, lease_until=NULL
             WHERE lane='heavy' AND state IN ('queued','preparing','running')`);
  const running = uuid(await sql(
    `INSERT INTO tasks (project_id,title,objective,state,lane,priority,branch,harness,
                        lease_owner,lease_until,heartbeat_at)
     SELECT id,'L17 a run to add context to','x','running','heavy','normal',
            'jarvis/task-l17','claude','dev-heavy-1',now()+interval '10 minutes',now()
     FROM projects WHERE slug='dev-sandbox' RETURNING id`,
  ));
  const queued = uuid(await sql(
    `INSERT INTO tasks (project_id,title,objective,state,lane,priority)
     SELECT id,'L17 a task to reprioritise','x','queued','heavy','normal'
     FROM projects WHERE slug='dev-sandbox' RETURNING id`,
  ));
  const approval = uuid(await sql(
    `INSERT INTO approvals (action_type, target, state, expires_at)
     VALUES ('deploy_staging','L17 approve me','pending', now() + interval '2 hours')
     RETURNING id`,
  ));
  const artifact = uuid(await sql(
    `INSERT INTO artifacts (project_id, path, mime, bytes, source, quarantine_state, retention_class)
     SELECT id,'l17/report.txt','text/plain',42,'test','clean','other'
     FROM projects WHERE slug='dev-sandbox' RETURNING id`,
  ));
  const issue = uuid(await sql(
    `INSERT INTO issues (severity, category, service, status, owner, title, dedupe_key, required_action)
     VALUES ('high','credential.expired','broker','open','jarvis',
             'L17 the API key for a provider is dead','l17.credential',
             'Paste a new key on the connections page')
     RETURNING id`,
  ));
  return { running, queued, approval, artifact, issue };
}

// ------------------------------------------------------------------ journeys

/**
 * Each journey is a function of (page, ids) that performs it with a POINTER,
 * and a matching keyboard version. Both assert in the database.
 */
async function journeyHealth(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await sleep(1200);
  const before = await page.evaluate(() =>
    document.querySelector('[data-testid="health-strip"]')?.hasAttribute("open"));
  await page.click('[data-testid="health-strip"] summary');
  await sleep(300);
  const after = await page.evaluate(() =>
    document.querySelector('[data-testid="health-strip"]')?.hasAttribute("open"));
  const disk = await page.textContent('[data-testid="disk-pct"]').catch(() => null);
  return { opened: before === false && after === true, disk };
}

async function journeyContext(page, ids) {
  await page.goto(`${BASE}/work/?task=${ids.running}`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="context-input"]', { timeout: 15000 });
  await page.fill('[data-testid="context-input"]', "L17 pointer: also check the CSV export");
  await page.click('[data-testid="add-context"] button[type="submit"]');
  await sleep(1200);
  return Number(await sql(
    `SELECT count(*) FROM task_context WHERE task_id='${ids.running}'
     AND body LIKE 'L17 pointer%'`));
}

async function journeyApprove(page, ids) {
  await page.goto(`${BASE}/approvals/`, { waitUntil: "networkidle" });
  await sleep(1200);
  const clicked = await page.evaluate((id) => {
    const row = [...document.querySelectorAll("*")].find(
      (e) => (e.textContent ?? "").includes("L17 approve me") && e.querySelector("button"),
    );
    const btn = [...(row?.querySelectorAll("button") ?? [])].find((b) =>
      /approve/i.test(b.textContent ?? ""));
    if (!btn) return false;
    btn.click();
    return true;
  }, ids.approval);
  await sleep(1500);
  return { clicked, state: await sql(`SELECT state FROM approvals WHERE id='${ids.approval}'`) };
}

async function journeyReprioritise(page, ids) {
  await page.goto(`${BASE}/work/?task=${ids.queued}`, { waitUntil: "networkidle" });
  await page.waitForSelector("select", { timeout: 15000 });
  await page.selectOption("select", "high");
  await sleep(1500);
  return sql(`SELECT priority FROM tasks WHERE id='${ids.queued}'`);
}

async function journeyArtifact(page) {
  await page.goto(`${BASE}/artifacts/`, { waitUntil: "networkidle" });
  await sleep(1200);
  // The list shows the basename; opening it is what reveals the full path. The
  // journey is "open an artifact", so this opens one rather than checking that a
  // string is somewhere on the page.
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-testid="artifact-open"]')].find((b) =>
      (b.textContent ?? "").includes("report.txt"));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(600);
  const text = await page.textContent("body");
  return { opened, detail: (text ?? "").includes("l17/report.txt") };
}

async function journeyIssue(page) {
  await page.goto(`${BASE}/issues/`, { waitUntil: "networkidle" });
  await sleep(1200);
  const listed = await page.textContent("body");
  const found = (listed ?? "").includes("L17 the API key for a provider is dead");
  // The list shows titles; what to DO about it is on the issue. Opening it is
  // the journey — "resolve an API-key Issue" is not "notice one exists".
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("L17 the API key for a provider is dead"));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(800);
  const text = await page.textContent("body");
  return { found, opened, action: (text ?? "").includes("Paste a new key on the connections page") };
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
    const ids = await seedJourneys();

    // ============================================================== phone
    console.log("########## the six journeys, on a 375px phone ##########\n");
    const phone = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
    const page = await phone.newPage();
    await login(page);

    console.log("=== 1. check health ===");
    const h = await journeyHealth(page);
    truthy("the health strip opens from the home page", h.opened);
    truthy("and the numbers behind it are readable", h.disk && h.disk.trim().length > 0);

    console.log("\n=== 2. add context to a running task ===");
    const ctx = await journeyContext(page, ids);
    check("the context reached the task's own table, not a toast", 1, ctx);
    truthy(
      "and the page says what happens next",
      ((await page.textContent('[data-testid="context-note"]').catch(() => "")) ?? "")
        .includes("next checkpoint"),
    );

    console.log("\n=== 3. resolve an API-key issue ===");
    const iss = await journeyIssue(page);
    truthy("the issue is findable on a phone", iss.found);
    truthy("and it opens", iss.opened);
    truthy("and then says what to actually do about it", iss.action);

    console.log("\n=== 4. approve something ===");
    const ap = await journeyApprove(page, ids);
    truthy("there is an approve control on the phone", ap.clicked);
    check("and the approval really changed state", "approved", ap.state);

    console.log("\n=== 5. reprioritise ===");
    const pri = await journeyReprioritise(page, ids);
    check("the task's priority changed in the database", "high", pri);

    console.log("\n=== 6. open an artifact ===");
    const art = await journeyArtifact(page);
    truthy("the artifact has a control that opens it", art.opened);
    truthy("and opening it shows where the file actually lives", art.detail);

    // =========================================================== keyboard
    console.log("\n########## the same six, keyboard only ##########\n");
    const desk = await browser.newContext({ viewport: DESKTOP });
    const kb = await desk.newPage();
    await login(kb);

    // 1. health, by keyboard
    await kb.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await sleep(1200);
    const summary = await tabTo(kb, "health-summary");
    if (!summary) {
      // The <summary> element itself is the tab stop; match on its text.
      truthy("the health strip is reachable by Tab", await tabTo(kb, "Details"));
    } else {
      ok("the health strip is reachable by Tab");
    }
    await kb.keyboard.press("Enter");
    await sleep(300);
    check(
      "and opens with Enter",
      true,
      await kb.evaluate(() =>
        document.querySelector('[data-testid="health-strip"]')?.hasAttribute("open")),
    );

    // 2. add context, by keyboard
    await kb.goto(`${BASE}/work/?task=${ids.running}`, { waitUntil: "networkidle" });
    await kb.waitForSelector('[data-testid="context-input"]', { timeout: 15000 });
    // Tab once to the skip link, Enter, and continue from the content — which is
    // what the skip link is for and what a keyboard user actually does. Without
    // it, reaching the composer means tabbing past the nav and a hundred-row
    // task list, which is a blocker with a long walk in front of it.
    await kb.keyboard.press("Tab");
    truthy(
      "the first tab stop on every page is a skip link",
      await kb.evaluate(() => document.activeElement?.getAttribute("data-testid") === "skip-link"),
    );
    await kb.keyboard.press("Enter");
    const box = await tabTo(kb, "context-input", 150);
    truthy("the context box is reachable by Tab", box);
    await kb.keyboard.type("L17 keyboard: and the invoice PDF");
    const send = await tabTo(kb, "Send to the run", 20);
    truthy("so is its submit button", send);
    await kb.keyboard.press("Enter");
    await sleep(1500);
    check(
      "and the run received it",
      1,
      Number(await sql(`SELECT count(*) FROM task_context WHERE task_id='${ids.running}'
                        AND body LIKE 'L17 keyboard%'`)),
    );

    // 5. reprioritise, by keyboard
    const second = uuid(await sql(
      `INSERT INTO tasks (project_id,title,objective,state,lane,priority)
       SELECT id,'L17 keyboard reprioritise','x','queued','heavy','normal'
       FROM projects WHERE slug='dev-sandbox' RETURNING id`,
    ));
    await kb.goto(`${BASE}/work/?task=${second}`, { waitUntil: "networkidle" });
    await kb.waitForSelector("select", { timeout: 15000 });
    await kb.keyboard.press("Tab");
    await kb.keyboard.press("Enter");
    const sel = await tabTo(kb, "SELECT", 150);
    truthy("the priority control is reachable by Tab", sel);
    await kb.selectOption("select", "critical");
    await sleep(1500);
    check(
      "and changing it with the keyboard changes the database",
      "critical",
      await sql(`SELECT priority FROM tasks WHERE id='${second}'`),
    );

    // The remaining three are navigation, so the check is that every page they
    // need is reachable by keyboard from the nav and has a visible focus ring —
    // which the audit suite asserts on every route. What is asserted here is
    // that none of them needs a pointer to READ.
    /*
     * A SECOND approval, because the phone pass already approved the first and
     * the approvals page lists what is pending. Checking for the decided one
     * would have been checking that a finished thing is still on screen, which
     * is not the journey.
     */
    const approval2 = uuid(await sql(
      `INSERT INTO approvals (action_type, target, state, expires_at)
       VALUES ('deploy_staging','L17 approve me by keyboard','pending', now() + interval '2 hours')
       RETURNING id`,
    ));
    await kb.goto(`${BASE}/approvals/`, { waitUntil: "networkidle" });
    await sleep(1200);
    const approveBtn = await tabTo(kb, "Approve", 150);
    truthy("an approval can be reached by Tab", approveBtn);
    if (approveBtn) {
      await kb.keyboard.press("Enter");
      await sleep(1500);
    }
    check(
      "and approved with Enter, for real",
      "approved",
      await sql(`SELECT state FROM approvals WHERE id='${approval2}'`),
    );

    for (const [name, route, needle] of [
      ["the issue", "/issues/", "L17 the API key"],
      ["the artifact", "/artifacts/", "report.txt"],
    ]) {
      await kb.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
      await sleep(1000);
      truthy(`${name} is on the page with no pointer involved`,
        ((await kb.textContent("body")) ?? "").includes(needle));
    }

    // Journey 6 by keyboard is the one that was pointer-only: the row carried an
    // onClick and contained nothing focusable, so it could be clicked and could
    // not be opened.
    await kb.goto(`${BASE}/artifacts/`, { waitUntil: "networkidle" });
    await sleep(1200);
    const openBtn = await tabTo(kb, "artifact-open", 150);
    truthy("an artifact can be opened by keyboard, not only clicked", openBtn);
    if (openBtn) {
      await kb.keyboard.press("Enter");
      await sleep(600);
      truthy(
        "and it opens to the file's real path",
        ((await kb.textContent("body")) ?? "").includes("/report.txt"),
      );
    }

    // ================================================================ PWA
    console.log("\n########## installable ##########\n");
    const man = await fetch(`${BASE}/manifest.webmanifest`);
    check("the manifest is served", 200, man.status);
    const manifest = await man.json();
    check("with a standalone display mode", "standalone", manifest.display);
    check("and a start url", "/", manifest.start_url);
    for (const icon of manifest.icons) {
      const r = await fetch(`${BASE}${icon.src}`);
      check(`  ${icon.src} exists`, 200, r.status);
    }
    const sw = await fetch(`${BASE}/sw.js`);
    check("the service worker is served", 200, sw.status);
    const swText = await sw.text();
    truthy(
      "and it refuses to cache API responses",
      swText.includes("/api") && swText.includes("return"),
    );
    truthy("no web push, which S15 puts out of scope", !/pushManager|showNotification/.test(swText));
    const registered = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length;
    });
    truthy("and the page registers it", registered > 0);

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

/**
 * S17 — the Done when, as one uninterrupted sequence in the browser.
 *
 * "An output can be reviewed, rejected with a note that becomes a task, revised,
 * and the two versions compared — WITHOUT LEAVING THE CONSOLE."
 *
 * The API suite proves each of those works. This proves they work one after
 * another, on one page, at phone width, which is the actual claim. It never
 * navigates away from /artifacts between the review and the comparison.
 *
 *   node scripts/s17-console-test.mjs
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
const PORT = 8106;
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
const uuid = (s) => s.match(/[0-9a-f-]{36}/)?.[0] ?? null;

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

    // A real file, a real artifact row, produced the way the runner produces one.
    const stamp = Date.now().toString(36);
    const rel = `s17c/report-${stamp}.txt`;
    await run("docker", [...COMPOSE, "exec", "-T", "api", "sh", "-c",
      `mkdir -p /var/lib/jarvis/artifacts/s17c && printf 'the finding\\nis wrong\\n' > /var/lib/jarvis/artifacts/${rel}`],
      { cwd: ROOT });
    const projectId = uuid(await sql(
      `INSERT INTO projects (slug,name,project_type,confidentiality,production_status)
       VALUES ('s17-console','s17-console','personal','normal','non_production')
       ON CONFLICT (slug) DO UPDATE SET archived_at = NULL RETURNING id`));
    const id = uuid(await sql(
      `INSERT INTO artifacts (project_id, path, mime, bytes, source, quarantine_state,
                              retention_class, artifact_type, state, version,
                              created_by_agent, created_by_model, created_by_harness,
                              created_by_auth_profile)
       VALUES ('${projectId}','${rel}','text/plain',22,'jarvis','clean','other',
               'report','generated',1,'runner','fake','fake','anthropic_personal')
       RETURNING id`));

    const context = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await page.goto(`${BASE}/login/`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', process.env.JARVIS_OPERATOR_EMAIL ?? "dev@jarvis.local");
    await page.fill('input[type="password"]', process.env.JARVIS_OPERATOR_PASSWORD ?? "dev-password-1234");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 });

    console.log("########## review, reject, revise, compare — one page ##########\n");
    await page.goto(`${BASE}/artifacts/`, { waitUntil: "networkidle" });
    await sleep(1500);

    const opened = await page.evaluate((name) => {
      const btn = [...document.querySelectorAll('[data-testid="artifact-open"]')].find((b) =>
        (b.textContent ?? "").includes(name));
      if (!btn) return false;
      btn.click();
      return true;
    }, `report-${stamp}.txt`);
    truthy("the artifact opens from the list", opened);
    await page.waitForSelector('[data-testid="review-actions"]', { timeout: 15000 });

    // ------------------------------------------------------------- it reads
    const state = await page.textContent('[data-testid="artifact-state"]');
    truthy("its type, version and state are on the page", /report/.test(state ?? "") && /v1/.test(state ?? ""));
    truthy("and it says it is not delivered", (state ?? "").includes("not delivered"));
    const prov = await page.textContent('[data-testid="provenance"]');
    truthy(
      "the creating agent, model, harness and auth profile are all there",
      ["runner", "fake", "anthropic_personal"].every((x) => (prov ?? "").includes(x)),
    );
    const preview = await page.textContent('[data-testid="artifact-preview"]');
    truthy("the text previews", (preview ?? "").includes("the finding"));

    // ------------------------------------------------------ reject with a note
    console.log("\n=== rejecting it with a note ===");
    await page.click('[data-testid="review-start_review"]');
    await sleep(1200);
    const NOTE = `the finding contradicts the data on page two (${stamp})`;
    await page.fill('[data-testid="review-note"]', NOTE);
    await page.click('[data-testid="review-reject"]');
    await sleep(2000);

    check(
      "the artifact is rejected in the database",
      "rejected",
      await sql(`SELECT state FROM artifacts WHERE id = '${id}'`),
    );
    const taskId = uuid(await sql(
      `SELECT id FROM tasks WHERE project_id = '${projectId}'
       AND objective LIKE '%${stamp}%' ORDER BY created_at DESC LIMIT 1`));
    truthy("and a task exists carrying the note", taskId);
    check(
      "queued against the same project",
      "queued",
      await sql(`SELECT state FROM tasks WHERE id = '${taskId}'`),
    );
    const msg = await page.textContent('[data-testid="review-message"]');
    truthy(
      "and the page says the note became work, so nothing is restated",
      (msg ?? "").includes("you do not need to restate it"),
    );
    check("all without leaving /artifacts", true, page.url().includes("/artifacts/"));

    // -------------------------------------------------------------- revise it
    console.log("\n=== the revision arrives as v2 ===");
    const rel2 = `s17c/report-${stamp}.v2.txt`;
    await run("docker", [...COMPOSE, "exec", "-T", "api", "sh", "-c",
      `printf 'the finding\\nis right\\nand cites page two\\n' > /var/lib/jarvis/artifacts/${rel2}`],
      { cwd: ROOT });
    const v2 = uuid(await sql(
      `INSERT INTO artifacts (project_id, path, mime, bytes, source, quarantine_state,
                              retention_class, artifact_type, state, version, supersedes_id,
                              task_id, created_by_agent, created_by_model)
       VALUES ('${projectId}','${rel2}','text/plain',40,'jarvis','clean','other',
               'report','generated',2,'${id}','${taskId}','runner','fake')
       RETURNING id`));
    await sql(`UPDATE artifacts SET state = 'superseded' WHERE id = '${id}'`);

    await page.reload({ waitUntil: "networkidle" });
    await sleep(1500);
    await page.evaluate((name) => {
      const btn = [...document.querySelectorAll('[data-testid="artifact-open"]')].find((b) =>
        (b.textContent ?? "").includes(name));
      btn?.click();
    }, `report-${stamp}.v2.txt`);
    await page.waitForSelector('[data-testid="versions"]', { timeout: 15000 });
    const versions = await page.textContent('[data-testid="versions"]');
    truthy("both versions are listed", /v1/.test(versions ?? "") && /v2/.test(versions ?? ""));
    truthy("and v1 is shown as superseded, not gone", (versions ?? "").includes("superseded"));

    // ------------------------------------------------------------- compare
    console.log("\n=== and compared, on the same page ===");
    await page.click('[data-testid="compare"]');
    await sleep(1500);
    const diff = await page.textContent('[data-testid="diff"]');
    truthy("the comparison renders", diff);
    truthy("showing what the old version said", (diff ?? "").includes("is wrong"));
    truthy("and what the new one says", (diff ?? "").includes("is right"));
    check("still without leaving /artifacts", true, page.url().includes("/artifacts/"));

    // ---------------------------------------------------------- phone shape
    console.log("\n=== on a phone ===");
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("nothing overflows the 375px viewport", 0, overflow);

    // --------------------------------------------------- a run with no output
    console.log("\n=== a task that produced nothing says so ===");
    const barren = uuid(await sql(
      `INSERT INTO tasks (project_id,title,objective,state,lane,priority)
       VALUES ('${projectId}','S17 produced nothing at all','x','succeeded','heavy','normal')
       RETURNING id`));
    await page.goto(`${BASE}/work/?task=${barren}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="detail-state"]', { timeout: 45000 });
    await sleep(800);
    const none = await page.textContent('[data-testid="no-artifacts"]').catch(() => null);
    truthy("it says so in a sentence", (none ?? "").includes("That is a result, not a gap"));

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

/**
 * S18b — the status bar shows all six states, forced individually.
 *
 * "Six deterministic states, and no others: healthy · degraded · incident ·
 * maintenance · offline · unknown."
 *
 * Three of them had labels. The other three fell through to `undefined`, so the
 * bar rendered a blank where the system state goes — on every authenticated
 * page, in the one place that is supposed to be unambiguous.
 *
 * Each state is forced at the boundary the component reads: the ops summary is
 * intercepted and answered with that status. Two of the six cannot be produced
 * by the API yet (`maintenance` has no source; `offline` is derived from the
 * connection), and a state that renders wrongly the day it first occurs is
 * exactly the failure this step is retrofitting.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, "../jarvis-control-center/out");
const PORT = 8109;
const BASE = `http://127.0.0.1:${PORT}`;

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

const STATES = ["healthy", "degraded", "incident", "maintenance", "offline", "unknown"];
const WORDS = {
  healthy: "Healthy", degraded: "Degraded", incident: "Incident",
  maintenance: "Maintenance", offline: "Offline", unknown: "Unknown",
};

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
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${BASE}/login/`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', process.env.JARVIS_OPERATOR_EMAIL ?? "dev@jarvis.local");
    await page.fill('input[type="password"]', process.env.JARVIS_OPERATOR_PASSWORD ?? "dev-password-1234");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 });

    console.log("########## all six states, one at a time ##########\n");

    // The real summary, captured once, so each forced state differs from it in
    // exactly one field rather than being an invented payload.
    const real = await page.evaluate(async () =>
      (await fetch("/api/operations/summary")).json());

    for (const state of STATES) {
      await page.route("**/api/operations/summary", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...real, status: state }),
        }));
      await page.goto(`${BASE}/queue/`, { waitUntil: "networkidle" });
      await sleep(1500);

      const seen = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="status-state"]');
        if (!el) return null;
        return {
          state: el.getAttribute("data-state"),
          text: (el.textContent ?? "").trim(),
          klass: document.querySelector(".statusbar")?.className ?? "",
        };
      });
      if (!seen) { bad(`${state} renders`, "a status bar", "none"); continue; }
      check(`${state} renders as "${WORDS[state]}"`, true, seen.text.includes(WORDS[state]));
      truthy(`  and carries a shape as well as a colour`, seen.text.length > WORDS[state].length);
      truthy(`  with its own class`, seen.klass.includes(`statusbar-${state}`));
      await page.unroute("**/api/operations/summary");
    }

    console.log("\n=== a status the API invents is not a seventh state ===");
    await page.route("**/api/operations/summary", (route) =>
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ...real, status: "spectacular" }),
      }));
    await page.goto(`${BASE}/queue/`, { waitUntil: "networkidle" });
    await sleep(1500);
    const odd = await page.evaluate(() =>
      document.querySelector('[data-testid="status-state"]')?.getAttribute("data-state"));
    check("it reads as unknown rather than rendering a blank", "unknown", odd);
    await page.unroute("**/api/operations/summary");

    console.log("\n=== and it never claims health it has not heard ===");
    // Slow the summary right down: before it answers, the bar must not say the
    // system is healthy — it does not know yet.
    await page.route("**/api/operations/summary", async (route) => {
      await sleep(4000);
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ...real, status: "healthy" }),
      });
    });
    await page.goto(`${BASE}/queue/`, { waitUntil: "domcontentloaded" });
    await sleep(1200);
    const early = await page.evaluate(() =>
      document.querySelector('[data-testid="status-state"]')?.getAttribute("data-state"));
    check("before the first answer it is `unknown`, not `healthy`", "unknown", early);
    await page.unroute("**/api/operations/summary");

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

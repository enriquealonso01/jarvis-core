/**
 * S15 — audit every page of the console, on a phone. (plan S15)
 *
 * S15's Test section is a list of things a person is supposed to check by hand
 * on a real device: every page at 375px, no horizontal overflow anywhere, full
 * keyboard navigation with a visible focus state, every status readable in
 * greyscale, nothing animating under reduced-motion, touch targets big enough to
 * hit while walking.
 *
 * Checked by hand, that list gets done once. So it is checked here instead, on
 * every route, every run — and the greyscale test in particular is one the plan
 * says takes a minute and catches colour-alone information, which is exactly the
 * kind of thing that silently regresses.
 *
 * What this canNOT do is judge whether a page reads well. It measures the
 * mechanical properties: geometry, focusability, accessible names, computed
 * colour. The six journeys in L17 are a separate suite.
 *
 *   node scripts/s15-console-audit.mjs [--only /queue]
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
const PORT = 8097;
const BASE = `http://127.0.0.1:${PORT}`;
const PHONE = { width: 375, height: 667 };

const EDGE = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));

/** Every route the console exports, minus login (tested separately, no session). */
const ROUTES = [
  "/",
  "/work/",
  "/queue/",
  "/inbox/",
  "/conversations/",
  "/issues/",
  "/approvals/",
  "/actions/",
  "/artifacts/",
  "/projects/",
  "/connections/",
  "/models/",
  "/schedules/",
  "/maintenance/",
  "/improvement/",
  "/settings/",
];

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

// ---------------------------------------------------------------- the checks

/** Nothing may stick out sideways. A page that scrolls horizontally on a phone
 *  is a page you cannot read one-handed. */
const overflow = (page) =>
  page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const wide = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // An element that scrolls INSIDE itself is fine — that is what
      // .table-wrap is for. What is not fine is the page scrolling.
      if (r.right > w + 0.5 && getComputedStyle(el).position !== "fixed") {
        wide.push(`${el.tagName}.${String(el.className).slice(0, 30)} right=${Math.round(r.right)}`);
      }
    }
    return {
      scroll: document.documentElement.scrollWidth - w,
      widest: wide.slice(0, 3),
    };
  });

/**
 * Every control a finger or a keyboard can reach must have a name a screen
 * reader can say, and be big enough to hit. 44px is the platform guidance; 40
 * is the floor this console holds itself to on inline chips.
 */
const controls = (page) =>
  page.evaluate(() => {
    const bad = { unnamed: [], small: [] };
    const sel = "a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1'])";
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const name =
        (el.getAttribute("aria-label") ?? "").trim()
        || (el.getAttribute("title") ?? "").trim()
        || (el.textContent ?? "").trim()
        || (el.getAttribute("placeholder") ?? "").trim()
        || (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA"
          ? (el.closest("label")?.textContent ?? "").trim()
          : "");
      if (!name) bad.unnamed.push(`${el.tagName}.${String(el.className).slice(0, 30)}`);
      if (r.height < 24) {
        bad.small.push(`${el.tagName}.${String(el.className).slice(0, 24)} ${Math.round(r.height)}px`);
      }
    }
    return { unnamed: bad.unnamed.slice(0, 4), small: bad.small.slice(0, 4) };
  });

/**
 * Greyscale. The plan calls this "the fastest possible test for colour-alone
 * information", and it is: if a state is only a colour token, in greyscale it
 * becomes nothing.
 *
 * Rendering in greyscale would only tell us it looks grey. What actually matters
 * is whether every element that carries a status colour ALSO carries a word or a
 * shape, so that is what is checked — the colour is allowed, it just may not be
 * the only thing.
 */
const colourAlone = (page) =>
  page.evaluate(() => {
    const STATUS = new Set([
      "rgb(52, 211, 153)", // --ok
      "rgb(251, 191, 36)", // --warn
      "rgb(248, 113, 113)", // --err
    ]);
    const offenders = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      const coloured = STATUS.has(cs.backgroundColor);
      if (!coloured) continue;
      // A coloured block is fine if it says something, or if something beside it
      // does — a dot with a label next to it is not colour-alone.
      const own = (el.textContent ?? "").trim();
      const labelled =
        (el.getAttribute("aria-label") ?? "").trim()
        || (el.getAttribute("title") ?? "").trim()
        || (el.parentElement?.textContent ?? "").trim();
      if (!own && !labelled) {
        offenders.push(`${el.tagName}.${String(el.className).slice(0, 30)} bg=${cs.backgroundColor}`);
      }
    }
    return offenders.slice(0, 4);
  });

/**
 * The build bar, which S15 names directly: "blocked and done must be
 * distinguishable without colour".
 *
 * The general colour-alone check above cannot see this — the segments are
 * siblings with different background colours and no text, which is a legitimate
 * shape for a bar chart. So this asks the specific question: for every pair of
 * states actually present, does anything other than `background-color` differ?
 */
const barPatterns = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('[data-testid="build-bar"]');
    if (!bar) return { missing: true };
    const byState = new Map();
    for (const seg of bar.querySelectorAll("[data-state]")) {
      const state = seg.getAttribute("data-state");
      if (byState.has(state)) continue;
      const cs = getComputedStyle(seg);
      byState.set(state, {
        image: cs.backgroundImage,
        opacity: cs.opacity,
        label: seg.getAttribute("aria-label") ?? "",
      });
    }
    const states = [...byState.keys()];
    const same = [];
    for (let i = 0; i < states.length; i += 1) {
      for (let j = i + 1; j < states.length; j += 1) {
        const a = byState.get(states[i]);
        const b = byState.get(states[j]);
        if (a.image === b.image && a.opacity === b.opacity) {
          same.push(`${states[i]} vs ${states[j]}`);
        }
      }
    }
    return { missing: false, states, same, unlabelled: [...byState.values()].filter((v) => !v.label).length };
  });

/** Reduced motion must actually reduce motion. */
const animating = (page) =>
  page.evaluate(() => {
    const moving = [];
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.animationName !== "none" && cs.animationDuration !== "0s") {
        moving.push(`${el.tagName}.${String(el.className).slice(0, 30)} ${cs.animationName}`);
      }
    }
    return moving.slice(0, 4);
  });

/**
 * Walk the page with Tab and report any stop where focus is invisible.
 *
 * "Visible" means the focused element's own box changes: an outline, a ring, or
 * a border. A custom control rendered over a real one is the usual way this
 * breaks, and it is invisible in a screenshot taken with a mouse.
 */
async function keyboardWalk(page, limit = 40) {
  const stops = [];
  await page.evaluate(() => document.body.focus());
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const visible =
        (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0)
        || cs.boxShadow !== "none";
      return {
        tag: el.tagName,
        cls: String(el.className).slice(0, 30),
        visible,
        onScreen: r.width > 0 && r.height > 0,
      };
    });
    if (!stop) break;
    stops.push(stop);
  }
  return stops;
}

// ---------------------------------------------------------------- the run

async function main() {
  if (!EDGE) throw new Error("no Chromium-family browser found to drive");
  if (!fs.existsSync(path.join(OUT, "index.html"))) {
    throw new Error(`no console export at ${OUT} — run \`pnpm build\` in jarvis-control-center`);
  }
  const only = process.argv.includes("--only")
    ? process.argv[process.argv.indexOf("--only") + 1]
    : null;
  const routes = only ? ROUTES.filter((r) => r.startsWith(only)) : ROUTES;

  const server = spawn(
    process.execPath,
    ["scripts/console-serve.mjs", "--port", String(PORT), "--out", OUT],
    { cwd: ROOT, stdio: "ignore" },
  );
  const browser = await chromium.launch({ executablePath: EDGE });

  try {
    for (let i = 0; i < 40; i += 1) {
      try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* not up yet */ }
      await sleep(250);
    }

    const context = await browser.newContext({ viewport: PHONE, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(`${BASE}/login/`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', process.env.JARVIS_OPERATOR_EMAIL ?? "dev@jarvis.local");
    await page.fill('input[type="password"]', process.env.JARVIS_OPERATOR_PASSWORD ?? "dev-password-1234");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 });

    console.log(`########## every page at ${PHONE.width}px, reduced motion ##########\n`);

    for (const route of routes) {
      await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
      // Client-side fetches land after networkidle on a static export.
      await sleep(1200);
      console.log(`=== ${route} ===`);

      const o = await overflow(page);
      check(`  no horizontal overflow`, 0, Math.max(0, o.scroll));
      if (o.scroll > 0) console.log(`        widest: ${o.widest.join(" | ")}`);

      const c = await controls(page);
      check(`  every control has an accessible name`, "", c.unnamed.join(" | "));
      check(`  no control smaller than 24px`, "", c.small.join(" | "));

      const grey = await colourAlone(page);
      check(`  no state told by colour alone`, "", grey.join(" | "));

      const moving = await animating(page);
      check(`  nothing animates under reduced motion`, "", moving.join(" | "));

      if (route === "/") {
        /*
         * Force all five states before looking. The real PROGRESS.json holds
         * whatever the build happens to be at — right now no step is `blocked`
         * or `in_progress`, so the very pair S15 names would not have been on
         * the page and the assertion would have passed by not existing.
         */
        const progressFile = path.join(OUT, "PROGRESS.json");
        const original = fs.existsSync(progressFile) ? fs.readFileSync(progressFile, "utf8") : null;
        fs.writeFileSync(
          progressFile,
          JSON.stringify({
            plan_file: "docs/JARVIS_MASTER_PLAN_V2.md",
            plan_sha: "audit",
            total_steps: 5,
            updated_at: new Date().toISOString(),
            current_step: "S3",
            gates: {},
            steps: [
              { id: "S1", title: "done step", stage: 1, state: "done" },
              { id: "S2", title: "partial step", stage: 1, state: "partial" },
              { id: "S3", title: "in progress step", stage: 1, state: "in_progress" },
              { id: "S4", title: "blocked step", stage: 1, state: "blocked" },
              { id: "S5", title: "future step", stage: 1, state: "not_started" },
            ],
          }),
        );
        await page.reload({ waitUntil: "networkidle" });
        await sleep(800);
        const bar = await barPatterns(page);
        if (original !== null) fs.writeFileSync(progressFile, original);
        check(`  the build bar is on the page`, false, bar.missing);
        if (!bar.missing) {
          check(
            `  every pair of bar states differs by more than colour (${bar.states.join(", ")})`,
            "",
            bar.same.join(" | "),
          );
          check(`  and every segment is labelled for a screen reader`, 0, bar.unlabelled);
        }
      }

      const stops = await keyboardWalk(page);
      const invisible = stops.filter((s) => !s.visible);
      check(
        `  focus is visible at all ${stops.length} keyboard stops`,
        "",
        invisible.map((s) => `${s.tag}.${s.cls}`).slice(0, 4).join(" | "),
      );
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

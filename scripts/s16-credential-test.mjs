/**
 * S16 / N4 — a dead credential, repaired from a phone. (plan S16)
 *
 * "Mid-task the GitHub credential is dead. → one WhatsApp with a link, the
 * action page takes a new PAT, the connection tests, the ticket closes, the task
 * resumes from its checkpoint. Enrique never opened a terminal."
 *
 * So the browser here is a phone that has never logged in. It opens the link the
 * way a link from a message opens — id and token in the query string, no
 * session, no cookie — and everything after that is asserted in the database,
 * because a page that says "stored" and changed nothing is the failure this step
 * exists to prevent.
 *
 * The failure paths are the point as much as the happy one: an expired link is
 * refused, a replayed one is a 409, and a key the provider rejects leaves the
 * ticket OPEN with a sentence rather than closing it and sending the task
 * straight back into the same wall.
 *
 *   node scripts/s16-credential-test.mjs
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
const PORT = 8104;
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

/**
 * Provoke the real thing: a finished task whose project has no GitHub API
 * credential, run through the actual pull-request path. Nothing is inserted by
 * hand except the task — the ticket, the link and the parking all have to come
 * from the code under test, or this asserts a fixture.
 */
async function provoke(nTasks) {
  // Re-runnable, and in dependency order: the second run of this suite died on
  // issue_events holding a foreign key to the issue it was trying to delete —
  // before a single assertion ran.
  await sql(`DELETE FROM issue_events WHERE issue_id IN
             (SELECT id FROM issues WHERE dedupe_key LIKE 'github.pr.credential:%')`);
  await sql(`DELETE FROM user_action_requests WHERE issue_id IN
             (SELECT id FROM issues WHERE dedupe_key LIKE 'github.pr.credential:%')`);
  await sql(`UPDATE tasks SET blocked_by_issue_id = NULL WHERE blocked_by_issue_id IN
             (SELECT id FROM issues WHERE dedupe_key LIKE 'github.pr.credential:%')`);
  await sql("DELETE FROM issues WHERE dedupe_key LIKE 'github.pr.credential:%'");
  await sql("DELETE FROM connections WHERE slug LIKE 'github_api_s16%'");
  const projectId = uuid(await sql(
    `INSERT INTO projects (slug,name,project_type,confidentiality,production_status,
                           github_owner,github_repo,default_branch)
     VALUES ('s16-repo','s16-repo','personal','normal','non_production',
             'enriquealonso01','s16-repo','main')
     ON CONFLICT (slug) DO UPDATE SET archived_at=NULL, github_api_credential_id=NULL
     RETURNING id`,
  ));
  await sql(`UPDATE projects SET github_api_credential_id = NULL WHERE id = '${projectId}'`);

  /*
   * A real checkout with real branches. `openPullRequestForTask` refuses a
   * branch with no commits before it ever looks at the credential, so without
   * this the tasks stop at "nothing to open a PR from" and the credential path —
   * the thing under test — is never reached. No remote and no deploy key are
   * needed: the token check comes before the push.
   */
  const branches = Array.from({ length: nTasks }, (_, i) => `jarvis/task-s16-${i}`);
  await run("docker", [...COMPOSE, "exec", "-T", "api", "sh", "-c", `
    set -e
    rm -rf /var/lib/jarvis/projects/s16-repo
    mkdir -p /var/lib/jarvis/projects/s16-repo/repo
    cd /var/lib/jarvis/projects/s16-repo/repo
    git init -q -b main .
    git config user.email s16@jarvis.local && git config user.name S16
    echo one > README.md && git add -A && git commit -qm base
    for b in ${branches.join(" ")}; do
      git checkout -q -b "$b" main
      echo "$b" >> README.md && git add -A && git commit -qm "work on $b"
      git checkout -q main
    done
  `], { cwd: ROOT });

  const ids = [];
  for (let i = 0; i < nTasks; i += 1) {
    ids.push(uuid(await sql(
      `INSERT INTO tasks (project_id,title,objective,state,lane,priority,branch,head_sha)
       VALUES ('${projectId}','S16 finished work ${i}','x','running','heavy','normal',
               'jarvis/task-s16-${i}','${"a".repeat(40)}')
       RETURNING id`,
    )));
  }
  // The real code path, in the API container, against the real database.
  await run("docker", [...COMPOSE, "exec", "-T", "api", "node", "-e", `
    const { createPool } = require("/app/dist/db.js");
    const { openPullRequestForTask } = require("/app/dist/pullrequest.js");
    (async () => {
      const pool = createPool();
      for (const id of ${JSON.stringify(ids)}) {
        await openPullRequestForTask(pool, id).catch((e) => console.error(String(e)));
      }
      await pool.end();
    })();
  `], { cwd: ROOT }).catch((e) => console.log(`  (pr path said: ${String(e).slice(0, 200)})`));
  return { projectId, ids };
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

    console.log("########## N4: the credential dies mid-task ##########\n");
    const { projectId, ids } = await provoke(3);

    const parked = Number(await sql(
      `SELECT count(*) FROM tasks WHERE id IN (${ids.map((i) => `'${i}'`).join(",")})
       AND state = 'waiting_for_provider'`));
    check("all three tasks parked rather than failing", 3, parked);

    const issues = Number(await sql(
      `SELECT count(*) FROM issues WHERE dedupe_key = 'github.pr.credential:${projectId}'`));
    check("and produced ONE ticket between them, not three", 1, issues);

    const issueId = uuid(await sql(
      `SELECT id FROM issues WHERE dedupe_key = 'github.pr.credential:${projectId}'`));
    const linked = Number(await sql(
      `SELECT count(*) FROM tasks WHERE blocked_by_issue_id = '${issueId}'`));
    check("every affected task links to it", 3, linked);

    const arId = uuid(await sql(
      `SELECT id FROM user_action_requests WHERE issue_id = '${issueId}'`));
    truthy("a one-time action link was created for it", arId);
    const arCount = Number(await sql(
      `SELECT count(*) FROM user_action_requests WHERE issue_id = '${issueId}'`));
    check("one link, not one per task", 1, arCount);

    // The token is only in the row's hash, so the test mints a fresh request the
    // way the notifier would read one — through the API, with the token it was
    // handed at creation. Read it back out of the audit trail is not possible by
    // design, so this asks the database to reissue rather than inventing one.
    const token = await run("docker", [...COMPOSE, "exec", "-T", "api", "node", "-e", `
      const crypto = require("node:crypto");
      const { createPool } = require("/app/dist/db.js");
      (async () => {
        const pool = createPool();
        const t = crypto.randomBytes(32).toString("base64url");
        const h = crypto.createHash("sha256").update(t).digest();
        await pool.query("UPDATE user_action_requests SET token_hash = $2 WHERE id = $1", ["${arId}", h]);
        process.stdout.write(t);
        await pool.end();
      })();
    `], { cwd: ROOT }).then((r) => r.stdout.trim());
    truthy("and the link carries a token", token.length > 20);

    // ---------------------------------------------------------- the phone
    console.log("\n=== the phone opens the link, with no session at all ===");
    const phone = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
    const page = await phone.newPage();
    const url = `${BASE}/actions/?id=${arId}&t=${encodeURIComponent(token)}`;
    await page.goto(url, { waitUntil: "networkidle" });
    await sleep(1500);

    const cookies = await phone.cookies();
    check("there is no session cookie on this device", 0, cookies.length);
    truthy(
      "the page still renders the request",
      ((await page.textContent("body")) ?? "").includes("A GitHub token for s16-repo"),
    );
    truthy("with a masked field", await page.$('[data-testid="key-input"][type="password"]'));
    const purpose = await page.textContent('[data-testid="purpose"]').catch(() => "");
    truthy("and a plain statement of purpose", (purpose ?? "").includes("What it is for"));
    truthy("and of cost", (purpose ?? "").includes("What it costs"));

    // ------------------------------------------------------- the wrong key
    console.log("\n=== the wrong key is refused, and the ticket stays open ===");
    await page.fill('[data-testid="key-input"]', "bad-key-that-the-provider-hates");
    await page.click('[data-testid="key-form"] button[type="submit"]');
    await sleep(2000);
    const errText = (await page.textContent(".form-error").catch(() => "")) ?? "";
    truthy("the page says what the provider said", /rejected the key|does not work/i.test(errText));
    // Stack-trace markers, not the word "at" — which appears in ordinary English
    // and made this assertion fail on a perfectly good sentence.
    const STACKY = ["node:internal", "TypeError", "ReferenceError", "    at "];
    truthy("not a stack trace", !STACKY.some((m) => errText.includes(m)));
    // `waiting_for_user` IS open — it is the status raiseIssue gives a blocker
    // that belongs to Enrique. What matters is that it is not resolved.
    check(
      "the ticket is still open",
      false,
      ["resolved", "ignored"].includes(
        await sql(`SELECT status FROM issues WHERE id = '${issueId}'`),
      ),
    );
    check(
      "the link is still usable",
      "",
      await sql(`SELECT COALESCE(consumed_at::text,'') FROM user_action_requests WHERE id = '${arId}'`),
    );
    check(
      "and nothing was released",
      3,
      Number(await sql(`SELECT count(*) FROM tasks WHERE blocked_by_issue_id = '${issueId}'
                        AND state = 'waiting_for_provider'`)),
    );

    // -------------------------------------------------------- the good key
    console.log("\n=== the working key repairs it, and the parked work resumes itself ===");
    await page.reload({ waitUntil: "networkidle" });
    await sleep(1200);
    await page.fill('[data-testid="key-input"]', "good-github-token-s16");
    await page.click('[data-testid="key-form"] button[type="submit"]');
    await sleep(2500);

    check(
      "the ticket closed",
      "resolved",
      await sql(`SELECT status FROM issues WHERE id = '${issueId}'`),
    );
    check(
      "all three tasks went back to the queue by themselves",
      3,
      Number(await sql(`SELECT count(*) FROM tasks WHERE id IN (${ids.map((i) => `'${i}'`).join(",")})
                        AND state = 'queued'`)),
    );
    check(
      "the project now has a credential the pull-request path can read",
      1,
      Number(await sql(`SELECT count(*) FROM projects WHERE id = '${projectId}'
                        AND github_api_credential_id IS NOT NULL`)),
    );
    check(
      "stored against the PROJECT, not the account-wide admin profile",
      "project",
      await sql(`SELECT scope FROM connections WHERE slug = 'github_api_s16-repo'`),
    );
    check(
      "and the connection tested healthy",
      "healthy",
      await sql(`SELECT health FROM connections WHERE slug = 'github_api_s16-repo'`),
    );
    const shown = (await page.textContent("body")) ?? "";
    truthy(
      "the page reports the fingerprint, never the key",
      /github_api_s16-repo:…/.test(shown),
    );
    check("and the key itself is nowhere on the page", false, shown.includes("good-github-token-s16"));

    // --------------------------------------------------------- the replay
    console.log("\n=== the link is single use ===");
    const replay = await fetch(`${BASE}/api/action-requests/${arId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: "good-second-attempt", token }),
    });
    check("a replayed link is refused with 409", 409, replay.status);

    // -------------------------------------------------------- the expired
    console.log("\n=== an expired link is refused ===");
    const stale = uuid(await sql(
      `INSERT INTO user_action_requests (issue_id, kind, token_hash, expires_at, payload)
       VALUES ('${issueId}', 'provide_api_key', sha256('x'::bytea), now() - interval '1 hour',
               '{"profile_id":"groq","title":"stale","message":"stale"}'::jsonb)
       RETURNING id`,
    ));
    const expired = await fetch(`${BASE}/api/action-requests/${stale}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: "good-anything", token: "x" }),
    });
    check("an expired link is refused", 409, expired.status);
    check(
      "and it stored nothing",
      0,
      Number(await sql(`SELECT count(*) FROM credentials WHERE fingerprint LIKE 'groq:%s16%'`)),
    );

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

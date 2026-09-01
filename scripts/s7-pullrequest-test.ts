/**
 * S7 — the pull request, and the three things that must happen when there
 * isn't one.
 *
 * S7's first Test line is "a real PR on a real private repo". That is blocked on
 * a GitHub token permission (BLOCKED.md), so it is NOT claimed here and S7 stays
 * partial. What this covers is the other three, all of which are about refusing
 * correctly:
 *
 *   - credential missing  -> one issue, one notification, the task parks. Not a crash.
 *   - the same task twice -> no duplicate PR.
 *   - a branch with no changes -> no PR, and it says why.
 *
 * These run against the local SSH git host, so the branch is really pushed and
 * the commit count really comes from git.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createPool } from "../src/db.js";
import { encryptGcm, loadMasterKey, newDek, wrapDek } from "../src/crypto.js";
import { openPullRequestForTask, prBody } from "../src/pullrequest.js";
import { loadProject, materialiseDeployKey, repoDir } from "../src/checkout.js";

const run = promisify(execFile);
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 300)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));
const contains = (m: string, needle: string, hay: string) =>
  hay.includes(needle) ? ok(m) : bad(m, `contains ${needle}`, hay);

const pool = createPool();

async function main(): Promise<void> {
  // iso-alpha is the S5 fixture: a real repo on the local SSH host with a real
  // deploy key. Reusing it means the push in this test is a real push.
  const project = await pool.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM projects WHERE slug = 'iso-alpha'`,
  );
  const p = project.rows[0];
  if (!p) throw new Error("run scripts/s5-isolation-test.sh first — it creates iso-alpha");
  const dir = repoDir(p.slug);

  const newTask = async (title: string, branch: string | null) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, objective, state, lane, priority, branch)
       VALUES ($1, $2, 'do the thing', 'running', 'heavy', 'normal', $3) RETURNING id`,
      [p.id, title, branch],
    );
    return r.rows[0].id;
  };

  // ------------------------------------------------ a branch with no changes
  console.log("=== a branch with no changes gets no pull request ===");
  await run("git", ["checkout", "-q", "main"], { cwd: dir }).catch(() => undefined);
  await run("git", ["branch", "-D", "jarvis/empty"], { cwd: dir }).catch(() => undefined);
  await run("git", ["branch", "jarvis/empty", "main"], { cwd: dir });
  const tEmpty = await newTask("S7 empty branch", "jarvis/empty");
  const rEmpty = await openPullRequestForTask(pool, tEmpty);
  console.log(`  ${JSON.stringify(rEmpty)}`);
  check("no PR was opened", false, rEmpty.ok);
  if (!rEmpty.ok) {
    contains("and it says why", "no commits", rEmpty.reason);
    check("the task was not parked for it", false, rEmpty.parked);
  }
  const reasonEmpty = await pool.query<{ r: string | null }>(
    `SELECT waiting_reason AS r FROM tasks WHERE id = $1`,
    [tEmpty],
  );
  contains("the reason is on the task", "no pull request", reasonEmpty.rows[0].r ?? "");

  // --------------------------------------------------- credential missing
  console.log("\n=== no API credential: one issue, task parks, no crash ===");
  await pool.query(`UPDATE projects SET github_api_credential_id = NULL WHERE id = $1`, [p.id]);
  await run("git", ["branch", "-D", "jarvis/work"], { cwd: dir }).catch(() => undefined);
  await run("git", ["checkout", "-q", "-b", "jarvis/work", "main"], { cwd: dir });
  await fs.writeFile(path.join(dir, "CHANGE.md"), "a real change\n");
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-q", "-m", "a real change"], { cwd: dir });
  await run("git", ["checkout", "-q", "main"], { cwd: dir });

  const tNoCred = await newTask("S7 no credential", "jarvis/work");
  const rNoCred = await openPullRequestForTask(pool, tNoCred);
  console.log(`  ${JSON.stringify(rNoCred).slice(0, 200)}`);
  check("no PR", false, rNoCred.ok);
  if (!rNoCred.ok) {
    check("the task parked", true, rNoCred.parked);
    contains("and the reason names the missing credential", "API credential", rNoCred.reason);
    contains("and says the admin token is not a substitute", "not a substitute", rNoCred.reason);
  }
  check("the task is waiting_for_provider, not failed", "waiting_for_provider",
    (await pool.query<{ s: string }>(`SELECT state AS s FROM tasks WHERE id=$1`, [tNoCred])).rows[0].s);
  const issues = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM issues WHERE dedupe_key = $1`,
    [`github.pr.credential:${p.id}`],
  );
  check("exactly one issue was raised", "1", issues.rows[0].n);

  // A second attempt must not raise a second issue.
  const tNoCred2 = await newTask("S7 no credential again", "jarvis/work");
  await openPullRequestForTask(pool, tNoCred2);
  const issues2 = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM issues WHERE dedupe_key = $1`,
    [`github.pr.credential:${p.id}`],
  );
  check("a second failure does not raise a second issue", "1", issues2.rows[0].n);
  const notif = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM notifications_outbox
     WHERE body ILIKE '%pull request%' OR body ILIKE '%API credential%'`,
  );
  truthy("a notification was queued for it", Number(notif.rows[0].n) >= 1);

  // ------------------------------------------------------- no duplicate PR
  console.log("\n=== the same task twice does not open two pull requests ===");
  const tTwice = await newTask("S7 idempotent", "jarvis/work");
  await pool.query(`UPDATE tasks SET pr_number = 4242, pr_url = 'https://example.invalid/pr/4242' WHERE id = $1`, [tTwice]);
  const again = await openPullRequestForTask(pool, tTwice);
  console.log(`  ${JSON.stringify(again)}`);
  check("it reports the existing PR", true, again.ok);
  if (again.ok) {
    check("with the same number", 4242, again.number);
    check("and says it did not create one", false, again.created);
  }
  check("no second PR was recorded", "4242",
    String((await pool.query<{ n: number }>(`SELECT pr_number AS n FROM tasks WHERE id=$1`, [tTwice])).rows[0].n));

  // --------------------------------------------------------- the PR body
  console.log("\n=== the body carries evidence, not the harness's own claims ===");
  await pool.query(
    `INSERT INTO task_attempts (task_id, n, verdict, reproduced, confidence, summary)
     VALUES ($1, 1, 'completed', true, 'high', 'changed the loop bound and added a test')`,
    [tTwice],
  );
  for (const [name, note] of [["reproduce", "confirmed the bug"], ["root_cause", "off-by-one"]]) {
    await pool.query(
      `INSERT INTO task_events (task_id, type, name, summary) VALUES ($1,'phase',$2,$3)`,
      [tTwice, name, note],
    );
  }
  const body = await prBody(pool, tTwice, " src/x.js | 2 +-\n");
  contains("it shows what changed", "src/x.js", body);
  contains("it shows the phases the run actually recorded", "root_cause", body);
  contains("it states whether the bug was reproduced", "reproduced: **yes**", body);
  contains("and the verdict", "verdict: **completed**", body);
  contains("and links back to the task", tTwice, body);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => {
    console.error(err);
    fail += 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

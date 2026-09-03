/**
 * S9 — independent review.
 *
 * Two failures matter here and only one of them is obvious. The obvious one is
 * missing a planted bug. The other, which the plan calls out explicitly, is a
 * reviewer that always finds something: that is noise, it gets ignored within a
 * week, and a review nobody reads is worse than no review because it looks like
 * a safeguard.
 *
 * So a clean change must come back with ZERO findings — not "nothing blocking",
 * zero — and the reviewer must be shown to be reading the diff rather than
 * guessing from the task title.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createPool } from "../src/db.js";
import { diffForTask, parseFindings, reviewTask, sendBackForRework } from "../src/review.js";
import { repoDir } from "../src/checkout.js";

const run = promisify(execFile);
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 260)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));
const contains = (m: string, n: string, h: string) => (h.includes(n) ? ok(m) : bad(m, `contains ${n}`, h));

const pool = createPool();
const SLUG = "s9-review";

async function git(args: string[], cwd: string) {
  return run("git", args, { cwd });
}

async function seed(): Promise<string> {
  const bare = `/var/lib/jarvis/dev-origins/${SLUG}.git`;
  const work = repoDir(SLUG);
  await fs.rm(bare, { recursive: true, force: true });
  await fs.rm(path.dirname(work), { recursive: true, force: true });
  await fs.mkdir(path.dirname(work), { recursive: true });
  await fs.mkdir(bare, { recursive: true });
  await run("git", ["init", "--bare", "-q", "--initial-branch=main", "."], { cwd: bare });
  const t = await fs.mkdtemp("/tmp/s9-");
  await run("git", ["init", "-q", "--initial-branch=main", "."], { cwd: t });
  await fs.mkdir(path.join(t, "src"), { recursive: true });
  await fs.writeFile(path.join(t, "src", "cart.js"),
    "export function total(items) {\n  let sum = 0;\n  for (let i = 0; i < items.length; i += 1) sum += items[i].price;\n  return sum;\n}\n");
  await git(["add", "-A"], t);
  await git(["-c", "user.email=s@j", "-c", "user.name=S", "commit", "-q", "-m", "cart"], t);
  await git(["push", "-q", bare, "main"], t);
  await run("git", ["clone", "-q", bare, work], { cwd: "/tmp" });
  await fs.rm(t, { recursive: true, force: true });

  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality,default_branch)
     VALUES ($1,$1,'personal','normal','main')
     ON CONFLICT (slug) DO UPDATE SET archived_at=NULL RETURNING id`,
    [SLUG],
  );
  return r.rows[0].id;
}

async function branchWith(projectId: string, name: string, mutate: (dir: string) => Promise<void>) {
  const dir = repoDir(SLUG);
  await git(["checkout", "-q", "main"], dir);
  await git(["branch", "-D", name], dir).catch(() => undefined);
  await git(["checkout", "-q", "-b", name, "main"], dir);
  await mutate(dir);
  await git(["add", "-A"], dir);
  await git(["-c", "user.email=t@j", "-c", "user.name=T", "commit", "-q", "-m", name], dir);
  await git(["checkout", "-q", "main"], dir);
  const r = await pool.query<{ id: string }>(
    `INSERT INTO tasks (project_id,title,objective,state,lane,priority,branch)
     VALUES ($1,$2,'do it','running','heavy','normal',$3) RETURNING id`,
    [projectId, name, name],
  );
  return r.rows[0].id;
}

async function main(): Promise<void> {
  const projectId = await seed();

  // ------------------------------------------------ the reviewer sees the diff
  console.log("=== the reviewer is given the diff, not an empty string ===");
  const tFlawed = await branchWith(projectId, "flawed", async (dir) => {
    await fs.writeFile(path.join(dir, "src", "cart.js"),
      "export function total(items) {\n  let sum = 0;\n  for (let i = 0; i <= items.length; i += 1) sum += items[i].price;\n  return sum;\n}\n");
  });
  const d = await diffForTask(pool, tFlawed);
  truthy("a diff was produced", !("error" in d) && d.diff.length > 0);
  if (!("error" in d)) contains("and it contains the changed line", "i <= items.length", d.diff);

  // ------------------------------------------------------ a planted bug
  console.log("\n=== a planted off-by-one is caught ===");
  const rFlawed = await reviewTask(pool, tFlawed);
  console.log(`  findings=${rFlawed.findings.length} blocking=${rFlawed.blocking.length} err=${rFlawed.error ?? "-"}`);
  check("the review ran", true, rFlawed.ok);
  truthy("it found something", rFlawed.findings.length > 0);
  truthy("and called it blocking", rFlawed.blocking.length > 0);
  contains("naming the file", "cart.js", rFlawed.findings.map((f) => f.file).join(","));
  check("the findings are recorded on the task", true,
    Number((await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM task_events WHERE task_id=$1 AND type='review'`, [tFlawed])).rows[0].n) > 0);

  console.log("\n--- and the work is sent back, not shipped ---");
  const back = await sendBackForRework(pool, tFlawed, rFlawed.blocking);
  check("requeued", true, back.requeued);
  check("the task is queued again", "queued",
    (await pool.query<{ s: string }>(`SELECT state AS s FROM tasks WHERE id=$1`, [tFlawed])).rows[0].s);
  const ctx = await pool.query<{ body: string }>(
    `SELECT body FROM task_context WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1`, [tFlawed]);
  contains("the findings reach the next run as context", "cart.js", ctx.rows[0]?.body ?? "");
  contains("and it is told not to ignore them silently", "do not silently ignore", ctx.rows[0]?.body ?? "");

  // ------------------------------------------------------- a clean change
  console.log("\n=== a correct change passes with NO invented findings ===");
  const tClean = await branchWith(projectId, "clean", async (dir) => {
    await fs.writeFile(path.join(dir, "src", "cart.js"),
      "export function total(items) {\n  let sum = 0;\n  for (let i = 0; i < items.length; i += 1) sum += items[i].price;\n  return Math.round(sum * 100) / 100;\n}\n");
  });
  const rClean = await reviewTask(pool, tClean);
  console.log(`  findings=${rClean.findings.length} blocking=${rClean.blocking.length}`);
  check("the review ran", true, rClean.ok);
  check("ZERO findings, not merely nothing blocking", 0, rClean.findings.length);
  check("and it is recorded as clean", "clean",
    (await pool.query<{ n: string }>(
      `SELECT name AS n FROM task_events WHERE task_id=$1 AND type='review' ORDER BY at DESC LIMIT 1`,
      [tClean])).rows[0]?.n ?? "-");

  // ------------------------------------------------------ empty diff fails
  console.log("\n=== an empty diff is an error, never a silent pass ===");
  // A branch identical to main: `commit` would fail with nothing staged, so it is
  // made directly rather than through branchWith.
  const dir = repoDir(SLUG);
  await git(["checkout", "-q", "main"], dir);
  await git(["branch", "-D", "empty"], dir).catch(() => undefined);
  await git(["branch", "empty", "main"], dir);
  const tEmpty = (
    await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id,title,objective,state,lane,priority,branch)
       VALUES ($1,'empty','x','running','heavy','normal','empty') RETURNING id`,
      [projectId],
    )
  ).rows[0].id;
  const rEmpty = await reviewTask(pool, tEmpty);
  console.log(`  ok=${rEmpty.ok} err=${rEmpty.error ?? "-"}`);
  check("it does NOT report a clean review", false, rEmpty.ok);
  contains("and says the diff was empty", "empty", rEmpty.error ?? "");

  // ------------------------------------------- a route that blinks once
  /*
   * A run reaches review having already reproduced, fixed, tested and
   * committed. Throwing that away because one call came back empty puts
   * finished work in front of a human for no reason, so the reviewer is asked
   * twice. Driven through the injected asker: an empty answer cannot be
   * provoked on demand from a real route.
   */
  console.log("");
  console.log("=== a reviewer that answers nothing once is asked again ===");
  const GOOD = JSON.stringify({ summary: "fine", findings: [] });
  let calls = 0;
  const blinkOnce = async () => { calls += 1; return calls === 1 ? "" : GOOD; };
  const rBlink = await reviewTask(pool, tFlawed, blinkOnce);
  check("it asked twice", 2, calls);
  check("and returned the second answer rather than parking", true, rBlink.ok);

  console.log("");
  console.log("=== a throw is retried too, and a reviewer truly down still parks ===");
  let thrown = 0;
  const throwsOnce = async () => {
    thrown += 1;
    if (thrown === 1) throw new Error("socket hang up");
    return GOOD;
  };
  const rThrow = await reviewTask(pool, tFlawed, throwsOnce);
  check("a first-attempt throw does not park the task", true, rThrow.ok);
  let down = 0;
  const alwaysEmpty = async () => { down += 1; return ""; };
  const rDown = await reviewTask(pool, tFlawed, alwaysEmpty);
  check("two empty answers stop, rather than looping", 2, down);
  check("and that is reported as a failed review", false, rDown.ok);
  contains("naming the reason", "no reviewer route answered", rDown.error ?? "");

  // ------------------------------------------- junk findings are discarded
  console.log("\n=== a finding with no file and no detail is not a finding ===");
  const junk = parseFindings('{"findings":[{"severity":"blocking"},{"severity":"note","file":"a.js"},'
    + '{"severity":"blocking","file":"b.js","detail":"real problem","why":"breaks"}],"summary":"x"}');
  check("only the substantive one survives", 1, junk.findings.length);
  check("and it is the real one", "b.js", junk.findings[0]?.file);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

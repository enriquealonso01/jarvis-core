/**
 * Feed the suite a deliberately bad run and require it to score badly.
 *
 *   node --import tsx scripts/s29-fluent-fraud.ts [case-id]
 *
 * The plan asks for this in as many words: *"Feed it a deliberately bad model
 * and confirm it scores badly rather than passing on fluency - a suite that
 * everything passes measures nothing."*
 *
 * Until this runs, the finding that two engines score alike has two readings,
 * and only one of them is about the engines. If a run that fixes NOTHING also
 * scores in the same band, the suite is not measuring engineering at all and
 * every number it has produced tonight is noise with a decimal point.
 *
 * The fraud is not a broken run. Broken runs are easy to fail. It is a fluent
 * one: it announces every phase, touches exactly the files a correct fix would
 * touch, adds a test, keeps the suite green, opens a pull request and writes an
 * outcome claiming success with high confidence. Everything a reviewer skimming
 * the process would want to see. The only thing it does not do is fix the bug -
 * its "test" asserts the behaviour the code already has, which is precisely the
 * shape of a test written to be green rather than to be right.
 *
 * No vendor call: the fraud is scripted, so this is fast, free and repeatable,
 * and it exercises the real measuring and scoring path rather than a copy.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPool } from "../src/db.js";
import { collectEvidence, loadCases, measureBranch, scoreRun } from "../src/benchmark.js";
import { proposeFloor, TIE_BAND, type BenchRow } from "../src/ranking.js";

const run = promisify(execFile);
const pool = createPool();
const CASE_ID = process.argv[2] ?? "score-hides-a-failure";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

async function git(args: string[], cwd: string): Promise<void> {
  await run("git", ["-c", "user.email=f@j", "-c", "user.name=Fraud", ...args], { cwd });
}

async function nodeTest(cwd: string): Promise<boolean> {
  return await run("node", ["--test"], { cwd, timeout: 120_000 }).then(() => true).catch(() => false);
}

async function main(): Promise<void> {
  const cases = await loadCases("benchmarks");
  const c = cases.find((x) => x.id === CASE_ID);
  if (!c) throw new Error(`no case ${CASE_ID}`);
  console.log(`fluent fraud on ${c.id}`);
  console.log("");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fraud-"));
  await git(["init", "-q", "--initial-branch=main", "."], dir);
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.mkdir(path.join(dir, "test"), { recursive: true });
  for (const f of await fs.readdir(path.join(c.dir, "seed"))) {
    await fs.copyFile(path.join(c.dir, "seed", f), path.join(dir, "src", f));
  }
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  await git(["add", "-A"], dir);
  await git(["commit", "-q", "-m", "seed"], dir);

  /*
   * The fraud, committed on a branch exactly as an agent would leave it.
   *
   * The source file is touched - a comment and a rename, so the diff looks like
   * work - and the "regression test" asserts what the unfixed code already
   * does. It passes. It would pass just as happily with the change reverted,
   * which is the whole point.
   */
  await git(["checkout", "-q", "-b", "jarvis/fluent-fraud"], dir);
  const target = (await fs.readdir(path.join(c.dir, "seed")))[0];
  const src = path.join(dir, "src", target);
  const original = await fs.readFile(src, "utf8");
  await fs.writeFile(src, `// Reviewed and hardened. See the regression test beside this file.\n${original}`);
  const testName = target.replace(/\.js$/, ".test.js");
  await fs.writeFile(
    path.join(dir, "test", testName),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      `import * as mod from "../src/${target}";`,
      "",
      "// Asserts what the code already does. Green on the fix, green without it.",
      'test("the module exports something callable", () => {',
      "  const fn = Object.values(mod).find((v) => typeof v === \"function\");",
      '  assert.equal(typeof fn, "function");',
      "});",
      "",
    ].join("\n"),
  );
  await git(["add", "-A"], dir);
  await git(["commit", "-q", "-m", "Fix the reported defect and add a regression test"], dir);

  const m = await measureBranch({
    dir, base: "main", branch: "jarvis/fluent-fraud", caseDir: c.dir, runTests: nodeTest,
  });
  console.log(`  measured: own=${m.own} hidden=${m.hidden} redGreen=${m.redGreen} files=${m.changed.join(", ")}`);

  /*
   * The process record of a model run, complete and immaculate. Every phase
   * announced in order, a clean tool record, a pull request, no escalation.
   */
  const t = await pool.query<{ id: string }>(
    `INSERT INTO tasks (title, objective, lane, state, priority, pr_number)
     VALUES ($1, $2, 'heavy', 'succeeded', 'normal', 99) RETURNING id`,
    [`fluent fraud (${c.id})`, c.objective]);
  const taskId = t.rows[0].id;
  const PHASES = ["preserve", "context", "reproduce", "inspect", "root_cause", "plan",
    "change", "tests", "checks", "commit"];
  for (const p of PHASES) {
    await pool.query(
      `INSERT INTO task_events (task_id, type, name, summary) VALUES ($1,'phase',$2,$3)`,
      [taskId, p, "done"]);
  }
  for (let i = 0; i < 20; i += 1) {
    await pool.query(
      `INSERT INTO task_events (task_id, type, name, summary) VALUES ($1,'tool',$2,$3)`,
      [taskId, "bash", "ok"]);
  }

  try {
    const evidence = await collectEvidence(pool, taskId, {
      hiddenTestsPassed: m.hidden,
      regressionTestsPassed: m.baseHadTests ? m.own : null,
      ownTestsPassed: m.own,
      redGreenVerified: m.redGreen,
      filesChanged: m.changed,
      expectedFiles: c.expectedFiles,
      tokens: null,
    });
    const scored = scoreRun(evidence);
    console.log(`  scored:   overall=${scored.overall === null ? "null" : scored.overall.toFixed(3)}`);
    console.log(`  ${JSON.stringify(scored.scores)}`);
    console.log("");

    // The floor the suite derived from its own recorded runs.
    const b = await pool.query<{ harness: string; suite: string; scores: Record<string, unknown> }>(
      `SELECT harness, suite, scores FROM benchmarks
        WHERE scores->>'invalid' IS NULL AND harness IN ('claude','codex')`);
    const rows: BenchRow[] = b.rows.map((x) => ({
      harness: x.harness,
      suite: x.suite,
      overall: x.scores.overall === undefined || x.scores.overall === null ? null : Number(x.scores.overall),
      scores: (x.scores.scores ?? {}) as Record<string, number | null>,
    }));
    const floor = proposeFloor(rows);

    scored.scores.hidden_tests === 0
      ? ok("the withheld suite fails, because nothing was fixed")
      : bad(`hidden_tests scored ${scored.scores.hidden_tests}`);
    scored.scores.test_quality === 0
      ? ok("and the test is caught: it passes with the change reverted")
      : bad(`test_quality scored ${scored.scores.test_quality} - a test asserting current behaviour was not caught`);
    scored.scores.correctness === 1 && scored.scores.scope_control === 1 && scored.scores.pr_quality === 1
      ? ok("while every process dimension is perfect - this is fluency, not work")
      : bad("the fraud failed on process, so this proves less than it should");

    const overall = scored.overall ?? 1;
    if (floor.ok) {
      console.log("");
      console.log(`  floor ${floor.floor.toFixed(2)} (${floor.basis})`);
      overall < floor.floor
        ? ok(`the fraud scores ${overall.toFixed(3)}, below the floor`)
        : bad(`the fraud scores ${overall.toFixed(3)}, at or above the floor of ${floor.floor.toFixed(2)}`);
      const margin = floor.floor - overall;
      /*
       * Clear of the floor by more than the suite's own noise.
       *
       * A fraud that sits inside one run's normal wobble of the floor is only
       * failed by luck: the next real run that scores a little low drags the
       * floor down onto it. The band is the one already derived from observed
       * spread, not a new number chosen to make this pass.
       */
      margin > TIE_BAND
        ? ok(`and it is clear of the floor by ${margin.toFixed(3)}, more than the ${TIE_BAND} noise band`)
        : bad(`it clears the floor by only ${margin.toFixed(3)}, within the ${TIE_BAND} noise band: process points nearly carried a run that fixed nothing`);
    } else {
      console.log(`  no floor to compare against: ${floor.reason}`);
    }
  } finally {
    await pool.query(`DELETE FROM task_events WHERE task_id = $1`, [taskId]);
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});

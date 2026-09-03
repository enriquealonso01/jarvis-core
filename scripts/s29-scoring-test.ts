/**
 * The suite must be failable.
 *
 * The plan's second test is the one that matters here: "Feed it a deliberately
 * bad model and confirm it scores badly rather than passing on fluency - a
 * suite that everything passes measures nothing." So the fixtures are a good
 * run, a fluent-but-wrong run, and a run that cheated by deleting the test.
 */
import { createPool } from "../src/db.js";
import { collectEvidence, scoreRun, type RunEvidence } from "../src/benchmark.js";

let fails = 0;
let passes = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const base: RunEvidence = {
  hiddenTestsPassed: true,
  regressionTestsPassed: true,
  ownTestsPassed: true,
  redGreenVerified: true,
  filesChanged: ["src/slugify.js", "test/slugify.test.js"],
  expectedFiles: ["src/slugify.js", "test/slugify.test.js"],
  toolCalls: 20,
  toolErrors: 0,
  phases: ["reproduce", "plan", "change", "tests", "checks", "commit", "push"],
  escalated: false,
  prOpened: true,
  prTitle: "Trim boundary dashes from slugs",
  tokens: 120000,
};

async function main() {
  console.log("1. a good run scores near the top");
  const good = scoreRun(base);
  (good.overall ?? 0) >= 0.95 ? ok(`overall ${good.overall}`) : bad(`overall ${good.overall}`);

  console.log("2. a fluent run that did not fix it scores badly");
  // Same prose, same phases, same PR - and the hidden tests say no.
  const fluent = scoreRun({
    ...base, hiddenTestsPassed: false, ownTestsPassed: false, redGreenVerified: null,
  });
  (fluent.overall ?? 1) < 0.7
    ? ok(`overall ${fluent.overall?.toFixed(2)} - fluency did not carry it`)
    : bad(`a run that fixed nothing scored ${fluent.overall}`);
  (good.overall ?? 0) > (fluent.overall ?? 0)
    ? ok("and it scores below the run that worked")
    : bad("the broken run scored at least as well as the good one");

  console.log("3. deleting the failing test is not a fix");
  const cheat = scoreRun({
    ...base, hiddenTestsPassed: false, regressionTestsPassed: false, redGreenVerified: null,
    filesChanged: ["test/slugify.test.js"],
  });
  (cheat.overall ?? 1) < 0.6 ? ok(`overall ${cheat.overall?.toFixed(2)}`) : bad(`scored ${cheat.overall}`);

  console.log("4. scope creep costs proportionally, not absolutely");
  const oneStray = scoreRun({ ...base, filesChanged: [...base.filesChanged, "README.md"] });
  const manyStray = scoreRun({
    ...base,
    filesChanged: [...base.filesChanged, "a.js", "b.js", "c.js", "d.js", "e.js", "f.js"],
  });
  (oneStray.scores.scope_control as number) > (manyStray.scores.scope_control as number)
    ? ok(`one stray ${(oneStray.scores.scope_control as number).toFixed(2)} beats six ${(manyStray.scores.scope_control as number).toFixed(2)}`)
    : bad("scope control did not distinguish one stray file from six");

  console.log("5. judgement is left unscored rather than invented");
  good.scores.root_cause_accuracy === null && good.scores.code_quality === null
    ? ok("root_cause_accuracy and code_quality are null")
    : bad("a judgement dimension was given a number");
  good.unscored.includes("root_cause_accuracy") && good.unscored.includes("code_quality")
    ? ok("and both are listed as unscored")
    : bad(`unscored is ${JSON.stringify(good.unscored)}`);

  console.log("6. spending less is not scoring better");
  // Otherwise a fast wrong answer outranks a slow right one.
  const cheap = scoreRun({ ...base, hiddenTestsPassed: false, ownTestsPassed: false, tokens: 100 });
  (cheap.overall ?? 1) < (good.overall ?? 0)
    ? ok("a cheap wrong run still ranks below a costly right one")
    : bad("quota folded into the score");

  await collectorChecks();

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

/**
 * The collector reads the record; it does not run anything.
 *
 * Seeded rows rather than a live run, because what is being checked is whether
 * the reading is right - a live run would prove the harness works and say
 * nothing about whether the evidence was gathered correctly.
 */
async function collectorChecks(): Promise<void> {
  const pool = createPool();
  const t = await pool.query<{ id: string }>(
    `INSERT INTO tasks (lane, title, objective, state, pr_number)
     VALUES ('heavy', 's29 collector', 'x', 'succeeded', 7) RETURNING id`);
  const id = t.rows[0].id;
  for (const [type, name] of [["phase", "reproduce"], ["phase", "change"], ["tool", "command_execution"], ["tool", "file_change"]]) {
    await pool.query(
      `INSERT INTO task_events (task_id, type, name) VALUES ($1, $2, $3)`, [id, type, name]);
  }

  console.log("7. the collector reads what the run recorded");
  const ev = await collectEvidence(pool, id, {
    hiddenTestsPassed: true, regressionTestsPassed: true, ownTestsPassed: true,
    redGreenVerified: true, filesChanged: ["a.js"], expectedFiles: ["a.js"], tokens: 10,
  });
  ev.toolCalls === 2 ? ok("counted the tool calls") : bad(`toolCalls=${ev.toolCalls}`);
  ev.phases.join(",") === "reproduce,change" ? ok("kept the phases in order") : bad(`phases=${ev.phases}`);
  ev.prOpened ? ok("saw the pull request") : bad("missed the pull request");
  ev.escalated === false ? ok("no escalation recorded") : bad("invented an escalation");

  console.log("8. an unrecorded dimension is unscored, not a free point");
  const scored = scoreRun(ev);
  scored.scores.tool_reliability === null && scored.unscored.includes("tool_reliability")
    ? ok("tool_reliability is null, because errors are not recorded anywhere")
    : bad(`tool_reliability scored ${scored.scores.tool_reliability} on data that does not exist`);

  await pool.query(`DELETE FROM task_events WHERE task_id = $1`, [id]);
  await pool.query(`DELETE FROM tasks WHERE id = $1`, [id]);
  await pool.end();
}

main();

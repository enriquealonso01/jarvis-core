/**
 * The suite must be failable.
 *
 * The plan's second test is the one that matters here: "Feed it a deliberately
 * bad model and confirm it scores badly rather than passing on fluency - a
 * suite that everything passes measures nothing." So the fixtures are a good
 * run, a fluent-but-wrong run, and a run that cheated by deleting the test.
 */
import { createPool } from "../src/db.js";
import { collectEvidence, isTestPath, scoreRun, type RunEvidence } from "../src/benchmark.js";

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

  console.log("8. a clean run and a failing one are now distinguishable");
  const clean = scoreRun(ev);
  clean.scores.tool_reliability === 1
    ? ok("no error events, so reliability is 1")
    : bad(`reliability is ${clean.scores.tool_reliability} on a run with no failures`);

  // One failure in two calls. Before this, both runs looked identical.
  await pool.query(
    `INSERT INTO task_events (task_id, type, name, summary)
     VALUES ($1, 'error', 'harness_error', 'command exited 1')`, [id]);
  const withFailure = await collectEvidence(pool, id, {
    hiddenTestsPassed: true, regressionTestsPassed: true, ownTestsPassed: true,
    redGreenVerified: true, filesChanged: ["a.js"], expectedFiles: ["a.js"], tokens: 10,
  });
  withFailure.toolErrors === 1 ? ok("the failure was counted") : bad(`toolErrors=${withFailure.toolErrors}`);
  const noisy = scoreRun(withFailure);
  (noisy.scores.tool_reliability as number) < 1
    ? ok(`reliability fell to ${(noisy.scores.tool_reliability as number).toFixed(2)}`)
    : bad("a run that failed a command scored the same as one that did not");

  console.log("9. both engines report a failed tool, not just one");
  /*
   * The normalised shape exists so a run reads the same whichever engine made
   * it. Codex emitted a first-class error item; Claude reported a failed tool
   * as a tool_result with is_error, and nothing read it - so reliability was
   * scorable for one engine and permanently unscored for the other.
   */
  const { RUNTIMES } = await import("../src/runtime.js");
  const claude = RUNTIMES.claude.normalise({
    type: "user",
    message: { content: [
      { type: "tool_result", is_error: true, content: "bash: node: command not found" },
      { type: "tool_result", is_error: false, content: "ok" },
    ] },
  });
  const claudeErrors = claude.filter((e) => e.kind === "error");
  claudeErrors.length === 1
    ? ok(`claude reports the failure (${(claudeErrors[0] as { message: string }).message.slice(0, 34)})`)
    : bad(`claude produced ${claudeErrors.length} error events from one failed tool`);

  const codex = RUNTIMES.codex.normalise({
    type: "item.completed", item: { type: "error", message: "command exited 1" },
  });
  codex.filter((e) => e.kind === "error").length === 1
    ? ok("codex still reports its own")
    : bad("codex stopped reporting errors");

  console.log("10. a run that recorded nothing gets no free point either");
  const empty = await pool.query<{ id: string }>(
    `INSERT INTO tasks (lane, title, objective, state) VALUES ('heavy', 's29 empty', 'x', 'succeeded') RETURNING id`);
  const nothing = await collectEvidence(pool, empty.rows[0].id, {
    hiddenTestsPassed: null, regressionTestsPassed: null, ownTestsPassed: null,
    redGreenVerified: null, filesChanged: [], expectedFiles: [], tokens: null,
  });
  nothing.toolErrors === null && scoreRun(nothing).scores.tool_reliability === null
    ? ok("zero errors out of zero calls is unscored, not perfect")
    : bad(`an empty run scored ${scoreRun(nothing).scores.tool_reliability}`);
  await pool.query(`DELETE FROM tasks WHERE id = $1`, [empty.rows[0].id]);

  // ---- writing no test must not beat writing a bad one
  console.log("");
  console.log("11. a missing test is a zero, not an excluded dimension");
  const noTest = scoreRun({
    ...base,
    redGreenVerified: null,
    filesChanged: ["src/slugify.js"],
  });
  const badTest = scoreRun({ ...base, redGreenVerified: false });
  noTest.scores.test_quality === 0
    ? ok("a run that changed code and added no test scores zero on test_quality")
    : bad(`writing no test scored ${noTest.scores.test_quality}`);
  (noTest.overall ?? 1) <= (badTest.overall ?? 0)
    ? ok("so writing nothing never outscores writing a test that fails to go red")
    : bad(`no test ${noTest.overall} beat a bad test ${badTest.overall}`);
  !noTest.unscored.includes("test_quality")
    ? ok("and it is reported as scored rather than unscored")
    : bad("a missing test was still listed as unscored");

  // ---- but genuinely unmeasurable stays unmeasured
  const addedButUnrun = scoreRun({
    ...base,
    redGreenVerified: null,
    filesChanged: ["src/slugify.js", "test/slugify.test.js"],
  });
  addedButUnrun.scores.test_quality === null
    ? ok("a test that was added but could not be run stays null")
    : bad(`an unrunnable test scored ${addedButUnrun.scores.test_quality}`);
  const noDiff = scoreRun({ ...base, redGreenVerified: null, filesChanged: [] });
  noDiff.scores.test_quality === null
    ? ok("and a run with no diff at all says nothing about testing")
    : bad(`an empty diff scored ${noDiff.scores.test_quality}`);

  // ---- a test is a test wherever the agent put it
  console.log("");
  console.log("12. the harness recognises a test outside test/");
  isTestPath("src/score.test.js")
    ? ok("a test beside the code counts as a test")
    : bad("src/score.test.js was not recognised as a test");
  isTestPath("test/score.test.js") && isTestPath("tests/a.spec.ts")
    ? ok("and so do test/ and tests/, .test and .spec")
    : bad("a conventional test path was not recognised");
  !isTestPath("src/score.js") && !isTestPath("src/latest.js")
    ? ok("while ordinary source is not mistaken for one")
    : bad("a source file was counted as a test");

  await pool.query(`DELETE FROM task_events WHERE task_id = $1`, [id]);
  await pool.query(`DELETE FROM tasks WHERE id = $1`, [id]);
  await pool.end();
}

main();

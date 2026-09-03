/**
 * What a benchmark run is worth, from evidence rather than from fluency.
 *
 * The plan names twelve dimensions. Nine of them are decidable from what a run
 * leaves behind - tests, files, events, a pull request - and two are not:
 * root-cause accuracy and code quality are judgements. Those are returned as
 * `null` and listed in `unscored` rather than given an invented number, because
 * a suite whose floor is set from made-up components measures the invention.
 *
 * "A suite that everything passes measures nothing": every dimension here can
 * be failed by a run that produced plausible prose, which is the point.
 */

export type RunEvidence = {
  /** The withheld suite the agent never saw. Null when it could not be run. */
  hiddenTestsPassed: boolean | null;
  /** The tests that existed before the run, still passing afterwards. */
  regressionTestsPassed: boolean | null;
  /** The agent's own tests, as it left them. */
  ownTestsPassed: boolean | null;
  /** Does the test it added fail without its fix? Null when it added none. */
  redGreenVerified: boolean | null;
  filesChanged: string[];
  /** What a correct fix is expected to touch. Anything else is scope creep. */
  expectedFiles: string[];
  toolCalls: number;
  /**
   * Null when the run kept no record of tool failures.
   *
   * `task_events` has no error type today, so a collector cannot tell a clean
   * run from one that failed half its commands. Reporting 0 would score every
   * run a perfect 1 on reliability - a dimension that always passes measures
   * nothing, so it goes unscored until the events carry it.
   */
  toolErrors: number | null;
  /** Phase names the run reported, in order. */
  phases: string[];
  escalated: boolean;
  prOpened: boolean;
  prTitle: string | null;
  /** Tokens spent, when the vendor reported them. */
  tokens: number | null;
};

export type Scored = {
  scores: Record<string, number | null>;
  unscored: string[];
  /** Everything that can be scored, averaged. Null when nothing could be. */
  overall: number | null;
};

const JUDGEMENT = ["root_cause_accuracy", "code_quality"];

/** A path that is a test rather than a fix. */
export function isTestPath(f: string): boolean {
  return /(^|\/)tests?\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
}

/**
 * How well the run tested its own fix.
 *
 * The distinction that matters is between "could not be determined" and "the
 * agent did not do it", and treating both as null rewarded the second. Red-green
 * is null when no test was added, that null excluded the dimension AND its
 * weight from the average, and so a run that wrote NO test scored higher than
 * one that wrote a test which failed to go red. Writing nothing beat writing
 * something imperfect - in a suite whose whole purpose is to stop process points
 * carrying a run that did not do the work.
 *
 * Measured on a real pair: a claude run that added no test scored 0.67, where a
 * bad test would have scored 0.61 and a good one 0.74.
 *
 * `correctness` does not already account for this, though a comment in the
 * runner claimed it did: the seed tests still pass when the agent adds none, so
 * that run scored correctness 1.
 *
 * Null survives for the case it was meant for: a test was added and the harness
 * could not run it, and a run that produced no diff at all, where nothing about
 * testing can be read either way.
 */
function testQuality(e: RunEvidence): number | null {
  if (e.redGreenVerified !== null) return e.redGreenVerified ? 1 : 0;
  if (e.filesChanged.length === 0) return null;
  return e.filesChanged.some(isTestPath) ? null : 0;
}

export function scoreRun(e: RunEvidence): Scored {
  const bool = (b: boolean | null): number | null => (b === null ? null : b ? 1 : 0);

  /*
   * Scope control is a ratio, not a flag: a run that touched one stray file is
   * not as wrong as one that rewrote the repository, and a flag cannot say so.
   */
  const stray = e.filesChanged.filter((f) => !e.expectedFiles.includes(f));
  const scope = e.filesChanged.length === 0
    ? null
    : Math.max(0, 1 - stray.length / e.filesChanged.length);

  const reliability = e.toolCalls === 0 || e.toolErrors === null
    ? null
    : Math.max(0, 1 - e.toolErrors / e.toolCalls);

  const scores: Record<string, number | null> = {
    reproduction: e.phases.includes("reproduce") ? 1 : 0,
    root_cause_accuracy: null,
    correctness: bool(e.ownTestsPassed),
    hidden_tests: bool(e.hiddenTestsPassed),
    regression_safety: bool(e.regressionTestsPassed),
    test_quality: testQuality(e),
    tool_reliability: reliability,
    scope_control: scope,
    code_quality: null,
    /*
     * Whether a pull request exists, not whether its prose is good. Title and
     * description quality is a judgement, and judgements are not scored here.
     */
    pr_quality: e.prOpened ? 1 : 0,
    // An escalation on a case the cheap route should handle is a cost, not a
    // success: the work finished, and it finished expensively.
    unnecessary_escalation: e.escalated ? 0 : 1,
    // Recorded, never averaged. Cheapness is not quality, and folding it in
    // would let a fast wrong answer outscore a slow right one.
    quota_consumed: e.tokens,
  };

  /*
   * Weighted, because a flat average is how a suite stops measuring.
   *
   * Averaged evenly, a run that reproduced the bug, kept its scope tight, used
   * its tools cleanly, opened a tidy pull request and FIXED NOTHING scored
   * 0.75 - the process points carried the wrong answer. Deleting the failing
   * test scored the same. That is the plan's own warning arriving in practice:
   * "a suite that everything passes measures nothing."
   *
   * So the weights say what the suite is for. Did it actually fix the bug,
   * proved by tests the agent never saw, is worth six times whether it opened
   * a well-titled pull request. The process dimensions still separate runs that
   * all worked, which is the only place they should decide anything.
   */
  const WEIGHTS: Record<string, number> = {
    hidden_tests: 3,
    correctness: 2,
    regression_safety: 2,
    test_quality: 1,
    scope_control: 1,
    tool_reliability: 1,
    reproduction: 0.5,
    pr_quality: 0.5,
    unnecessary_escalation: 0.5,
  };

  let weighted = 0;
  let total = 0;
  for (const [k, v] of Object.entries(scores)) {
    const w = WEIGHTS[k];
    if (v === null || w === undefined) continue;
    weighted += v * w;
    total += w;
  }

  return {
    scores,
    unscored: [...JUDGEMENT, ...Object.entries(scores)
      .filter(([k, v]) => v === null && !JUDGEMENT.includes(k) && k !== "quota_consumed")
      .map(([k]) => k)],
    overall: total ? weighted / total : null,
  };
}

/**
 * What a finished run left behind, read from the database.
 *
 * Deliberately does not run anything: the test-execution half needs the repo
 * and the branch, and mixing "read the record" with "check out and run" makes
 * both harder to test. This half is provable offline with seeded rows, which is
 * why it is separate.
 */
export async function collectEvidence(
  pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  taskId: string,
  tests: {
    hiddenTestsPassed: boolean | null;
    regressionTestsPassed: boolean | null;
    ownTestsPassed: boolean | null;
    redGreenVerified: boolean | null;
    filesChanged: string[];
    expectedFiles: string[];
    tokens: number | null;
  },
): Promise<RunEvidence> {
  const events = await pool.query(
    `SELECT type, name FROM task_events WHERE task_id = $1 ORDER BY at`, [taskId]);
  const phases = events.rows.filter((r) => r.type === "phase").map((r) => String(r.name ?? ""));
  const toolCalls = events.rows.filter((r) => r.type === "tool").length;
  const toolErrors = events.rows.filter((r) => r.type === "error").length;

  const esc = await pool.query(
    `SELECT count(*) AS n FROM escalations WHERE task_id = $1`, [taskId]);
  const task = await pool.query(
    `SELECT pr_number FROM tasks WHERE id = $1`, [taskId]);

  return {
    ...tests,
    toolCalls,
    /*
     * Counted only when the run produced tool calls at all. A run with no
     * events recorded nothing, and "zero errors out of zero calls" is an
     * absence of evidence rather than a clean sheet.
     */
    toolErrors: toolCalls === 0 ? null : toolErrors,
    phases,
    escalated: Number(esc.rows[0]?.n ?? 0) > 0,
    prOpened: task.rows[0]?.pr_number != null,
    prTitle: null,
  };
}

export type BenchmarkCase = {
  id: string;
  title: string;
  source: string;
  objective: string;
  expectedFiles: string[];
  difficulty: string;
  note?: string;
  dir: string;
};

/**
 * Load the case corpus from disk.
 *
 * Cases are files rather than rows because they are code: a seed the agent
 * starts from and a hidden suite it never sees. Keeping them in the repository
 * means a case is reviewed like code, and the fix it expects can be read.
 */
export async function loadCases(root: string): Promise<BenchmarkCase[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dirs = await fs.readdir(path.join(root, "cases")).catch(() => [] as string[]);
  const out: BenchmarkCase[] = [];
  for (const id of dirs.sort()) {
    const dir = path.join(root, "cases", id);
    const raw = await fs.readFile(path.join(dir, "case.json"), "utf8").catch(() => null);
    if (!raw) continue;
    const c = JSON.parse(raw) as Omit<BenchmarkCase, "dir">;
    out.push({ ...c, dir });
  }
  return out;
}

/**
 * Is this case honest?
 *
 * A case whose hidden tests pass against the SEED measures nothing: the bug is
 * either not in the seed or not covered by the tests, and every engine scores
 * full marks for doing nothing. Checked by running them, not by reading them.
 */
export async function caseIsFailable(
  c: BenchmarkCase,
  run: (cwd: string) => Promise<boolean>,
): Promise<{ failable: boolean; detail: string }> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `bench-${c.id}-`));
  try {
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, "test"), { recursive: true });
    for (const f of await fs.readdir(path.join(c.dir, "seed"))) {
      await fs.copyFile(path.join(c.dir, "seed", f), path.join(tmp, "src", f));
    }
    for (const f of await fs.readdir(path.join(c.dir, "hidden"))) {
      await fs.copyFile(path.join(c.dir, "hidden", f), path.join(tmp, "test", f));
    }
    await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));
    const passed = await run(tmp);
    return {
      failable: !passed,
      detail: passed ? "the hidden tests PASS against the seed - the case proves nothing" : "fails on the seed, as a case must",
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

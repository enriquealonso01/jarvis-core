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
  toolErrors: number;
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

  const reliability = e.toolCalls === 0 ? null : Math.max(0, 1 - e.toolErrors / e.toolCalls);

  const scores: Record<string, number | null> = {
    reproduction: e.phases.includes("reproduce") ? 1 : 0,
    root_cause_accuracy: null,
    correctness: bool(e.ownTestsPassed),
    hidden_tests: bool(e.hiddenTestsPassed),
    regression_safety: bool(e.regressionTestsPassed),
    test_quality: bool(e.redGreenVerified),
    tool_reliability: reliability,
    scope_control: scope,
    code_quality: null,
    pr_quality: e.prOpened && Boolean(e.prTitle && e.prTitle.trim()) ? 1 : 0,
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

import type pg from "pg";

/**
 * What a checkpoint has to carry so a resumed run continues rather than restarts
 * (plan S18b, II.3 "What a checkpoint must contain").
 *
 * The runner wrote twelve fields, all of them recording WHERE a run got to:
 * branch, head sha, worktree, transcript, exit code. None of them recorded WHY.
 * The plan is explicit about the cost: "Without them a resuming worker restarts
 * the investigation from the beginning, which looks like recovery and costs like
 * a rerun."
 *
 * None of this is new information — it is all already in `task_events`, written
 * as the run happened. It was simply never gathered into the thing recovery
 * reads.
 */

export type Investigation = {
  /** The plan phase's own note: what the run decided to do. */
  current_plan: string | null;
  /** Files the run touched, from git rather than from the agent's account of itself. */
  files_modified: string[];
  /** The commands it actually ran, in order. */
  commands_executed: string[];
  /** What the test and check phases reported. */
  test_results: string[];
  /** The root-cause phase's note — the belief the next worker should continue from. */
  current_hypothesis: string | null;
  /** The phase it had not reached yet. */
  next_intended_action: string | null;
};

/**
 * The eleven phases in order, duplicated from workflow.ts deliberately: this
 * module is imported by the runner's checkpoint path and must not drag the
 * prompt builder in with it.
 */
const PHASES = [
  "preserve", "context", "reproduce", "inspect", "root_cause",
  "plan", "change", "tests", "checks", "commit", "push",
] as const;

export async function investigationState(
  pool: pg.Pool,
  taskId: string,
  filesModified: string[],
): Promise<Investigation> {
  const events = await pool.query<{ type: string; name: string | null; summary: string | null }>(
    `SELECT type, name, summary FROM task_events
     WHERE task_id = $1 AND type IN ('phase', 'tool', 'review')
     ORDER BY at, id`,
    [taskId],
  );

  const phaseNote = (phase: string): string | null => {
    // The LAST note for a phase, not the first: a phase revisited on a second
    // attempt has a newer conclusion, and the older one is history.
    let found: string | null = null;
    for (const e of events.rows) {
      if (e.type === "phase" && e.name === phase && e.summary) found = e.summary;
    }
    return found;
  };

  const done = new Set(
    events.rows.filter((e) => e.type === "phase" && e.name).map((e) => e.name as string),
  );
  const next = PHASES.find((p) => !done.has(p)) ?? null;

  return {
    current_plan: phaseNote("plan"),
    files_modified: filesModified,
    commands_executed: events.rows
      .filter((e) => e.type === "tool" && e.name === "Bash" && e.summary)
      .map((e) => e.summary as string)
      .slice(-40),
    test_results: [phaseNote("tests"), phaseNote("checks")].filter((x): x is string => Boolean(x)),
    current_hypothesis: phaseNote("root_cause"),
    next_intended_action: next,
  };
}

/**
 * The same six fields, read back off the newest checkpoint, for the resume path.
 *
 * The plan's Debug section names the failure this exists to prevent: "If a
 * resumed run 'continues' but redoes work, the fields are being written and not
 * read. Check the resume path before the write path — it is the same mistake the
 * original checkpoint bug made."
 */
export async function lastInvestigation(
  pool: pg.Pool,
  taskId: string,
): Promise<Investigation | null> {
  const r = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM task_checkpoints
     WHERE task_id = $1 AND payload ? 'current_hypothesis'
     ORDER BY at DESC LIMIT 1`,
    [taskId],
  );
  const p = r.rows[0]?.payload;
  if (!p) return null;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  return {
    current_plan: (p.current_plan as string) ?? null,
    files_modified: strings(p.files_modified),
    commands_executed: strings(p.commands_executed),
    test_results: strings(p.test_results),
    current_hypothesis: (p.current_hypothesis as string) ?? null,
    next_intended_action: (p.next_intended_action as string) ?? null,
  };
}

/** The part of the prompt that hands the previous attempt's thinking forward. */
export function investigationBrief(inv: Investigation | null): string {
  if (!inv) return "";
  const lines: string[] = [];
  if (inv.current_hypothesis) {
    lines.push(
      "",
      "WHAT THE PREVIOUS ATTEMPT BELIEVED, AND WHY YOU ARE NOT STARTING OVER:",
      `Its hypothesis was: ${inv.current_hypothesis}`,
      "Continue from that. If you come to disagree with it, say so explicitly and say why —",
      "but do not re-derive it from nothing, which is what costs a whole run.",
    );
  }
  if (inv.current_plan) lines.push("", `Its plan was: ${inv.current_plan}`);
  if (inv.next_intended_action) {
    lines.push(`It was about to: ${inv.next_intended_action}.`);
  }
  if (inv.test_results.length) {
    lines.push("", `What the tests said last time: ${inv.test_results.join(" | ")}`);
  }
  if (inv.files_modified.length) {
    lines.push("", `Files it had already changed: ${inv.files_modified.slice(0, 20).join(", ")}`);
  }
  if (inv.commands_executed.length) {
    lines.push(
      `Commands it had already run (newest last): ${inv.commands_executed.slice(-8).join(" ; ")}`,
    );
  }
  return lines.join("\n");
}

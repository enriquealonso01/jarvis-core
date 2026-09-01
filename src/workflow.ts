import fs from "node:fs/promises";
import path from "node:path";
import type pg from "pg";

/**
 * The senior-engineer loop (plan S6, §27).
 *
 * v1's plan gave this nineteen lines out of two thousand, and v1 duly built
 * everything except this. It is the part that decides whether Jarvis is an
 * engineer or a text generator with repository access, so it is spelled out
 * rather than implied.
 *
 * Two things here are load-bearing and neither is about writing code:
 *
 *  - **Phases are announced, not inferred.** The harness appends a line to
 *    `.jarvis/phases.jsonl` as it enters each phase and the runner reads that
 *    file at its checkpoint boundary. Pulled, not pushed, for the same reason
 *    mid-run context is pulled: a process mid-model-call has nowhere to receive
 *    a signal. It also means a killed run resumes at the phase it reached.
 *  - **The verdict is separate from the exit code.** "It exited 0" and "it fixed
 *    the bug" are different claims. The harness writes `.jarvis/outcome.json`
 *    saying what it actually achieved, and a run that could not reproduce, or
 *    that is guessing, says so and does NOT get recorded as a success. A guess
 *    presented as a fix is a failure.
 */

export const PHASES = [
  "preserve",
  "context",
  "reproduce",
  "inspect",
  "root_cause",
  "plan",
  "change",
  "tests",
  "checks",
  "commit",
  "push",
] as const;

export type Phase = (typeof PHASES)[number];

export type Outcome = {
  /** Did it get the reported problem to happen? */
  reproduced: boolean;
  /** completed | not_reproducible | out_of_scope | pre_existing_failure | blocked */
  verdict: string;
  /** Is this a guess rather than a understood fix? A guess is never a success. */
  guess: boolean;
  confidence: "high" | "medium" | "low" | string;
  notes: string;
  /** What it tried, when it could not reproduce. Required for that verdict. */
  attempted?: string[];
  /** What evidence was missing. */
  missing?: string[];
};

export const VERDICTS_THAT_SUCCEED = new Set(["completed"]);

/**
 * Verdicts that are honest reports rather than failures.
 *
 * "I could not reproduce this, here is what I tried" is a correct outcome, not a
 * crash — it goes back to Enrique for more information rather than opening an
 * incident. Recording it as `failed_terminal` would teach him to ignore the
 * failure column.
 */
export const VERDICTS_THAT_ASK = new Set([
  "not_reproducible",
  "out_of_scope",
  "pre_existing_failure",
  "blocked",
]);

export function workflowPrompt(args: {
  objective: string;
  title: string;
  agentsMd: string | null;
  resumeFrom: Phase | null;
  completed: Phase[];
}): string {
  const resume = args.resumeFrom
    ? [
        "",
        "THIS IS A RESUMED RUN.",
        `Already finished: ${args.completed.join(", ") || "(nothing recorded)"}.`,
        `Start at the "${args.resumeFrom}" phase. Do not redo the earlier ones —`,
        "read what the previous attempt left in the worktree and continue from there.",
      ].join("\n")
    : "";

  const agents = args.agentsMd
    ? ["", "This project's AGENTS.md follows. It overrides anything below it that conflicts.", "", args.agentsMd]
    : ["", "This project has no AGENTS.md. Work out how to build and test it from the repository itself,", "and say so in your notes if you cannot."];

  return [
    `TASK: ${args.title}`,
    "",
    args.objective,
    resume,
    "",
    "HOW TO WORK",
    "",
    "Work through these phases in order. As you ENTER each one, append a single line of JSON",
    'to .jarvis/phases.jsonl in the repository root: {"phase":"<name>","note":"<one line>"}',
    "Create the .jarvis directory if it does not exist. One line per phase, appended, never rewritten.",
    "",
    PHASES.map((p, i) => `  ${i + 1}. ${p}${phaseHelp(p)}`).join("\n"),
    "",
    "THE RULES THAT MATTER MORE THAN FINISHING",
    "",
    "1. If you cannot REPRODUCE the problem, stop and say so. Do not fix what you cannot see failing.",
    "   Record what you tried and what evidence was missing. That is a complete, correct answer.",
    "2. A guess presented as a fix is a failure. If you are not sure the change addresses the cause,",
    '   say guess: true. It will be shown to Enrique as a guess, which is useful; a guess dressed as',
    "   a fix is worse than nothing.",
    "3. If the repository's tests were ALREADY failing before you touched anything, report that.",
    "   Do not claim credit for a green run you did not cause, and do not blame yourself for a red one",
    "   you did not cause.",
    "4. If the request is outside this repository's scope, decline it and say why. Do not widen the",
    "   change to make it fit.",
    "5. Make the SMALLEST sound change. Add a test that fails without your fix and passes with it.",
    "",
    "WHEN YOU FINISH, whatever the result, write .jarvis/outcome.json:",
    "",
    "  {",
    '    "reproduced": true|false,',
    '    "verdict": "completed" | "not_reproducible" | "out_of_scope" | "pre_existing_failure" | "blocked",',
    '    "guess": true|false,',
    '    "confidence": "high" | "medium" | "low",',
    '    "notes": "what you did, or why you could not",',
    '    "attempted": ["..."],',
    '    "missing": ["..."]',
    "  }",
    "",
    "That file is how your work is judged. A run without it is treated as incomplete.",
    ...agents,
  ].join("\n");
}

function phaseHelp(p: Phase): string {
  switch (p) {
    case "preserve":
      return " — read the report and any attachments; do not modify them";
    case "context":
      return " — read AGENTS.md, the README, and how this project is built and tested";
    case "reproduce":
      return " — make the reported problem actually happen. If you cannot, stop here";
    case "inspect":
      return " — read the code, logs and data you are permitted to read";
    case "root_cause":
      return " — say WHY it happens, not just where";
    case "plan":
      return " — the smallest sound change that addresses the cause";
    case "change":
      return " — make it";
    case "tests":
      return " — a test that fails without your change and passes with it";
    case "checks":
      return " — lint, typecheck, and the project's own test command";
    case "commit":
      return " — one commit, imperative subject, explaining why";
    case "push":
      return " — push the branch";
    default:
      return "";
  }
}

/**
 * Read the phases the harness has announced and record any that are new.
 *
 * Called from the runner's heartbeat, so the console sees the loop as it
 * happens rather than after it ends. Returns the latest phase, which becomes
 * the resume point if the run dies.
 */
export async function drainPhases(
  pool: pg.Pool,
  taskId: string,
  worktree: string,
  seen: Set<string>,
): Promise<Phase | null> {
  const file = path.join(worktree, ".jarvis", "phases.jsonl");
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  let latest: Phase | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { phase?: string; note?: string };
    try {
      entry = JSON.parse(trimmed) as { phase?: string; note?: string };
    } catch {
      continue;
    }
    const phase = (entry.phase ?? "").trim();
    if (!(PHASES as readonly string[]).includes(phase)) continue;
    latest = phase as Phase;
    // Keyed on the phase name, not the line: a harness that re-announces a
    // phase should not produce a second row, and a truncated read should not
    // lose one.
    if (seen.has(phase)) continue;
    seen.add(phase);
    await pool
      .query(
        `INSERT INTO task_events (task_id, type, name, summary) VALUES ($1, 'phase', $2, $3)`,
        [taskId, phase, (entry.note ?? "").slice(0, 500)],
      )
      .catch(() => undefined);
    await pool
      .query(`UPDATE tasks SET phase = $2, updated_at = now() WHERE id = $1`, [taskId, phase])
      .catch(() => undefined);
  }
  return latest;
}

/**
 * What the run says it achieved.
 *
 * A missing file is not "success with no notes" — it is an incomplete run, and
 * it is reported as one.
 */
export async function readOutcome(worktree: string): Promise<Outcome | null> {
  try {
    const raw = await fs.readFile(path.join(worktree, ".jarvis", "outcome.json"), "utf8");
    const o = JSON.parse(raw) as Partial<Outcome>;
    if (typeof o.verdict !== "string") return null;
    return {
      reproduced: o.reproduced === true,
      verdict: o.verdict,
      guess: o.guess === true,
      confidence: typeof o.confidence === "string" ? o.confidence : "unknown",
      notes: typeof o.notes === "string" ? o.notes : "",
      attempted: Array.isArray(o.attempted) ? o.attempted.map(String) : undefined,
      missing: Array.isArray(o.missing) ? o.missing.map(String) : undefined,
    };
  } catch {
    return null;
  }
}

/** The phases already recorded for a task, so a resumed run can skip them. */
export async function completedPhases(pool: pg.Pool, taskId: string): Promise<Phase[]> {
  const r = await pool.query<{ name: string }>(
    `SELECT DISTINCT name FROM task_events WHERE task_id = $1 AND type = 'phase'`,
    [taskId],
  );
  const done = new Set(r.rows.map((x) => x.name));
  return PHASES.filter((p) => done.has(p));
}

/** The phase a resumed run should start at: the one after the last completed. */
export function nextPhase(completed: Phase[]): Phase | null {
  if (!completed.length) return null;
  const last = completed[completed.length - 1];
  const i = PHASES.indexOf(last);
  return i >= 0 && i + 1 < PHASES.length ? PHASES[i + 1] : null;
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type pg from "pg";
import { quickCompletion } from "./supervisor.js";
import { repoDir } from "./checkout.js";

const run = promisify(execFile);

/**
 * A second opinion, from a different model, before the pull request exists
 * (plan S9).
 *
 * The failure this is designed against is not "the reviewer missed something".
 * It is "the reviewer always finds something", which is noise, and which gets
 * ignored within a week — at which point the review is worse than none, because
 * it looks like a safeguard and is not one. So:
 *
 *  - the prompt says plainly that finding nothing is a valid and common answer;
 *  - a finding must name a file and say what goes wrong, or it is dropped;
 *  - `blocking` is reserved for defects, not preferences. Style opinions are
 *    recorded and do not send the work back.
 *
 * The other half is the Debug note the plan gives: if review always passes,
 * check it is receiving the diff and not an empty string. An empty diff is
 * therefore an explicit error here, never a silent pass.
 */

export const REVIEW_MARKER = "INDEPENDENT CODE REVIEW";

export type Finding = {
  severity: "blocking" | "minor" | "note";
  file: string;
  detail: string;
  why: string;
};

export type ReviewResult = {
  ok: boolean;
  findings: Finding[];
  blocking: Finding[];
  /** Why the review could not run, when it could not. */
  error?: string;
  model: string;
};

function systemPrompt(): string {
  return [
    `${REVIEW_MARKER}. You are reviewing a diff written by another engineer, before it becomes a`,
    "pull request. You did not write it and you are not defending it.",
    "",
    "Report only DEFECTS — things that are wrong, not things you would have done differently:",
    "  - off-by-one and boundary errors",
    "  - a dropped null/undefined check that the code can actually reach",
    "  - a test that asserts nothing, or that cannot fail",
    "  - a change that does not do what its commit message says",
    "  - an obvious security or data-loss mistake",
    "",
    "FINDING NOTHING IS A NORMAL AND FREQUENT ANSWER. A reviewer that always finds",
    "something is noise, and noise gets ignored. If the change is sound, return an",
    "empty findings list and say so. Do not pad. Do not report style, naming, or",
    "preferences as findings.",
    "",
    "Reply with JSON only, no prose and no markdown fence:",
    '{"findings":[{"severity":"blocking|minor|note","file":"path","detail":"what is wrong",',
    '"why":"what breaks because of it"}],"summary":"one line"}',
    "",
    "Use `blocking` only for a defect that would break behaviour or lose data.",
  ].join("\n");
}

function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseFindings(raw: string): { findings: Finding[]; summary: string } {
  const parsed = extractJson(raw) as { findings?: unknown; summary?: unknown } | null;
  const list = Array.isArray(parsed?.findings) ? (parsed!.findings as unknown[]) : [];
  const findings: Finding[] = [];
  for (const entry of list) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const file = typeof e.file === "string" ? e.file.trim() : "";
    const detail = typeof e.detail === "string" ? e.detail.trim() : "";
    // A finding that names no file and says nothing is not a finding. Dropping
    // these is what stops "the reviewer always finds something" from being true
    // by accident.
    if (!file || !detail) continue;
    const sev = String(e.severity ?? "note").toLowerCase();
    findings.push({
      severity: sev === "blocking" ? "blocking" : sev === "minor" ? "minor" : "note",
      file,
      detail,
      why: typeof e.why === "string" ? e.why.trim() : "",
    });
  }
  return {
    findings,
    summary: typeof parsed?.summary === "string" ? parsed.summary.trim() : "",
  };
}

/** The diff a review should look at: what this branch adds to its base. */
export async function diffForTask(
  pool: pg.Pool,
  taskId: string,
): Promise<{ diff: string } | { error: string }> {
  const r = await pool.query<{ slug: string; branch: string | null; base: string | null }>(
    `SELECT p.slug, t.branch, p.default_branch AS base
     FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`,
    [taskId],
  );
  const row = r.rows[0];
  if (!row?.branch) return { error: "the task has no branch to review" };
  const base = row.base || "main";
  const dir = repoDir(row.slug);
  try {
    const { stdout } = await run(
      "git",
      ["diff", `${base}...${row.branch}`, "--", ".", ":(exclude).jarvis"],
      { cwd: dir, maxBuffer: 8 * 1024 * 1024 },
    );
    return { diff: stdout };
  } catch (err) {
    return { error: `could not read the diff: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Review a task's diff and record what came back.
 *
 * Never invents a pass. An empty diff, an unreachable reviewer, or an
 * unparseable reply are all errors — because each of them produces "no
 * findings", and "no findings" from a review that never happened is the single
 * most dangerous output this function could return.
 */
/**
 * How the reviewer is asked. Injectable so the retry below can be tested
 * without a network: the failure it exists for is a route returning nothing,
 * and that cannot be provoked on demand from a real one.
 */
export type AskReviewer = (system: string, diff: string) => Promise<string | null>;

export async function reviewTask(
  pool: pg.Pool,
  taskId: string,
  ask?: AskReviewer,
): Promise<ReviewResult> {
  const d = await diffForTask(pool, taskId);
  if ("error" in d) return { ok: false, findings: [], blocking: [], error: d.error, model: "none" };
  if (!d.diff.trim()) {
    return {
      ok: false,
      findings: [],
      blocking: [],
      error: "the diff was empty, so there was nothing to review",
      model: "none",
    };
  }

  // Truncated from the top: the beginning of a diff is the part that says which
  // files changed, and losing that makes every finding unattributable.
  const diff = d.diff.length > 60_000 ? `${d.diff.slice(0, 60_000)}\n[... diff truncated]` : d.diff;

  const askReviewer: AskReviewer =
    ask ?? ((system, body) => quickCompletion(pool, system, body, { maxTokens: 1500, role: "reviewer" }));

  /*
   * Asked twice before giving up.
   *
   * An empty answer parks a task as waiting_for_user, and a heavy run reaches
   * review having already reproduced the bug, fixed it, tested it and committed
   * - so a route that blinks once throws away finished work and puts it in front
   * of a human. Seen in production on 2026-09-03: a run that had done everything
   * right parked on "no reviewer route answered", and the same route answered a
   * 113KB diff three times out of three a minute later.
   *
   * One retry, not a loop: if the reviewer is genuinely down, parking is the
   * right outcome and retrying at length only delays it. The retry re-enters
   * routing, so a second attempt can land on a different route.
   */
  let raw: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      raw = await askReviewer(systemPrompt(), diff);
    } catch (err) {
      // A throw on the first attempt is retried too - a dead socket and an
      // empty body are the same event from here.
      if (attempt === 1) {
        return {
          ok: false,
          findings: [],
          blocking: [],
          error: `the reviewer failed: ${err instanceof Error ? err.message : String(err)}`,
          model: "none",
        };
      }
      raw = null;
    }
    if (raw && raw.trim()) break;
  }
  if (!raw || !raw.trim()) {
    return { ok: false, findings: [], blocking: [], error: "no reviewer route answered", model: "none" };
  }

  const { findings, summary } = parseFindings(raw);
  const blocking = findings.filter((f) => f.severity === "blocking");

  await pool
    .query(
      `INSERT INTO task_events (task_id, type, name, summary)
       VALUES ($1, 'review', $2, $3)`,
      [
        taskId,
        blocking.length ? "blocking" : findings.length ? "findings" : "clean",
        (summary || `${findings.length} finding(s), ${blocking.length} blocking`).slice(0, 500),
      ],
    )
    .catch(() => undefined);
  for (const f of findings) {
    await pool
      .query(
        `INSERT INTO task_events (task_id, type, name, summary)
         VALUES ($1, 'review', $2, $3)`,
        [taskId, `finding:${f.severity}`, `${f.file}: ${f.detail}${f.why ? ` — ${f.why}` : ""}`.slice(0, 500)],
      )
      .catch(() => undefined);
  }

  return { ok: true, findings, blocking, model: "reviewer" };
}

/**
 * Hand blocking findings back to the harness and requeue.
 *
 * Reuses the S3c task_context path rather than inventing a second channel: the
 * runner already delivers pending context into the worktree at its checkpoint
 * boundary, so a re-run sees the findings as a file it can read. `review_rounds`
 * caps this — two models disagreeing forever is a way to spend a subscription,
 * not a way to get a fix.
 */
export const MAX_REVIEW_ROUNDS = 2;

export async function sendBackForRework(
  pool: pg.Pool,
  taskId: string,
  blocking: Finding[],
): Promise<{ requeued: boolean; reason: string }> {
  const rounds = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM task_events
     WHERE task_id = $1 AND type = 'review' AND name = 'blocking'`,
    [taskId],
  );
  if (Number(rounds.rows[0]?.n ?? 0) > MAX_REVIEW_ROUNDS) {
    return {
      requeued: false,
      reason: `review found blocking issues again after ${MAX_REVIEW_ROUNDS} rounds; stopping rather than looping`,
    };
  }

  const body = [
    "A second model reviewed your change and found problems that must be fixed before it can",
    "become a pull request. Address each one, then run the project's tests again.",
    "",
    ...blocking.map((f) => `- ${f.file}: ${f.detail}${f.why ? ` (${f.why})` : ""}`),
    "",
    "If you believe a finding is wrong, say so in .jarvis/outcome.json notes and explain why —",
    "do not silently ignore it.",
  ].join("\n");

  await pool.query(
    `INSERT INTO task_context (task_id, body, attached_state)
     VALUES ($1, $2, (SELECT state FROM tasks WHERE id = $1))`,
    [taskId, body],
  );
  await pool.query(
    `UPDATE tasks SET state = 'queued', lease_owner = NULL, lease_until = NULL,
       waiting_reason = $2, updated_at = now()
     WHERE id = $1`,
    [taskId, `sent back: ${blocking.length} blocking review finding(s)`],
  );
  await pool
    .query(
      `INSERT INTO task_transitions (task_id, from_state, to_state, cause, actor)
       VALUES ($1, 'running', 'queued', 'review found blocking issues', 'reviewer')`,
      [taskId],
    )
    .catch(() => undefined);
  return { requeued: true, reason: `${blocking.length} blocking finding(s) sent back for rework` };
}

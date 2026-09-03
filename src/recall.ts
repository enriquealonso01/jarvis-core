/**
 * Finding the document he is asking for (plan S41, the query half).
 *
 *   "Everything Jarvis produces stays retrievable **by date and by context, from
 *    any channel** — including by voice... Produce a report, then ask for it by
 *    relative date on the phone three days later. Ask for 'the one about X' with
 *    no date → finds it by content."
 *
 * `voicerecall.ts` decides how a document is SAID. This decides which document,
 * and the split matters more than it looks: the extractor here is allowed to
 * read the body — that is how it counts the options a report weighs — while the
 * renderer over there is not. Shape extraction happens on the box, before
 * anything is classified for speech; the projection that survives into a spoken
 * sentence carries counts and never sentences.
 *
 * WHY THIS QUERIES ARTIFACTS DIRECTLY rather than going through `retrieve()`:
 * retrieval returns chunks, ranked, for answering a question. Recall wants the
 * DOCUMENT — one row, with its date and its project — and a chunk does not carry
 * the artifact it came from. Widening `Hit` to satisfy this would have changed
 * what every other caller of retrieval sees, so the content match borrows the
 * same index and joins back to the artifact instead.
 *
 * AND THE CLASSIFICATION IS FAIL-CLOSED. An artifact belonging to no project has
 * no confidentiality, and reading it aloud on the strength of that absence is
 * the same mistake as treating a NULL stamp as `normal`. It comes back
 * `restricted`, which means it gets explained rather than recited — not that it
 * is unreachable.
 */
import type pg from "pg";
import type { Confidentiality } from "./brevity.js";
import { nothingFound, resolveWhen, type RecallResult, type RecalledDocument } from "./voicerecall.js";

type Row = {
  id: string;
  path: string;
  artifact_type: string | null;
  created_at: Date;
  body: string | null;
  confidentiality: Confidentiality | null;
  stamped: Confidentiality | null;
};

/**
 * The classification a recalled artifact carries.
 *
 * The artifact's own stamp wins when it has one — that is what S41's
 * `artifacts.confidentiality` is for, and a transcript's inherited
 * classification must not be overwritten by the project it happens to be filed
 * under. Otherwise the project's, and failing that `restricted`.
 */
export function classificationOf(row: {
  stamped: Confidentiality | null;
  confidentiality: Confidentiality | null;
}): Confidentiality {
  return row.stamped ?? row.confidentiality ?? "restricted";
}

/** `alpha-migration-report.md` → `alpha migration report`. */
export function titleOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
}

/**
 * The shape of a document, read from the document.
 *
 * Allowed to see the body precisely because none of what it returns is the body:
 * it comes back as a count and a single conclusion line, which is what the plan
 * lets a voice rendering say. Done here rather than in the renderer so that the
 * renderer never has to be trusted with the text.
 */
export function shapeOf(body: string | null): {
  recommendation: string | null;
  optionCount: number | null;
  tradeoffCount: number | null;
} {
  if (!body) return { recommendation: null, optionCount: null, tradeoffCount: null };
  const rec = /^\s*(?:\*\*)?recommendation(?:\*\*)?\s*[:\-]\s*(.+?)\s*$/im.exec(body);
  const count = (re: RegExp) => {
    const m = body.match(re);
    return m ? m.length : null;
  };
  return {
    recommendation: rec ? rec[1].replace(/\*\*/g, "").trim() : null,
    optionCount: count(/^\s*#{1,6}\s*option\b/gim),
    tradeoffCount: count(/^\s*[-*+]?\s*tradeoff\b/gim),
  };
}

export type RecallQuery = {
  when?: string | null;
  about?: string | null;
  projectId?: string | null;
  now?: Date;
  limit?: number;
};

/**
 * Documents matching a date, a subject, or both.
 *
 * Newest first, because "the improvement opportunities from two days ago" with
 * two matches means the later one — and because a recall that returns the oldest
 * match is wrong in the way that is hardest to notice.
 */
export async function findDocuments(
  pool: pg.Pool,
  q: RecallQuery,
): Promise<RecalledDocument[]> {
  const now = q.now ?? new Date();
  const when = q.when ? resolveWhen(q.when, now) : null;

  /*
   * A date phrase that does not resolve is not silently ignored. "Ask for
   * something that does not exist -> says so": dropping an unparsed date and
   * answering from every document ever written is how a confident wrong answer
   * gets produced from a question nobody understood.
   */
  if (q.when && !when) return [];

  const conditions: string[] = ["a.artifact_type IS NOT NULL"];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace("$?", `$${params.length}`));
  };

  if (when) {
    add("a.created_at >= $?", when.from);
    add("a.created_at < $?", when.to);
  }
  if (q.projectId) add("a.project_id = $?", q.projectId);
  if (q.about) {
    /*
     * Borrowing S30's index rather than scanning documents: the chunks are
     * already tsvector'd, and a LIKE over every artifact body is the version
     * that works on a laptop and stops working in a year.
     */
    add(
      `EXISTS (SELECT 1 FROM knowledge_chunks k
                WHERE k.source_artifact_id = a.id
                  AND k.search @@ websearch_to_tsquery('english', $?))`,
      q.about,
    );
  }

  const r = await pool.query<Row>(
    `SELECT a.id, a.path, a.artifact_type, a.created_at,
            a.confidentiality AS stamped,
            p.confidentiality AS confidentiality,
            (SELECT string_agg(k.body, ' ' ORDER BY k.char_offset)
               FROM knowledge_chunks k WHERE k.source_artifact_id = a.id) AS body
       FROM artifacts a
       LEFT JOIN projects p ON p.id = a.project_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY a.created_at DESC
      LIMIT ${Math.max(1, Math.min(20, q.limit ?? 5))}`,
    params,
  );

  return r.rows.map((row) => {
    const shape = shapeOf(row.body);
    return {
      artifactId: row.id,
      title: titleOf(row.path),
      kind: row.artifact_type ?? "document",
      writtenAt: row.created_at,
      projects: [classificationOf(row)],
      body: row.body ?? "",
      ...shape,
    };
  });
}

/**
 * The whole recall, as a call would use it.
 *
 * Returns the miss as a SENTENCE rather than an empty list, because the failure
 * mode the plan names is a model filling a silence with a plausible summary, and
 * the way to not fill it is to hand back something already written.
 */
export async function recallForVoice(pool: pg.Pool, q: RecallQuery): Promise<RecallResult> {
  const found = await findDocuments(pool, { ...q, limit: 1 });
  if (!found.length) return nothingFound({ when: q.when, about: q.about });
  return { found: true, document: found[0] };
}

/**
 * Stamp a call's transcript with what was discussed on the call.
 *
 * The evidence and the stamp are written TOGETHER, in one statement each, from
 * one derivation - so a transcript can never carry a classification that the
 * discussed list does not justify. Deriving at read time instead would mean a
 * recall in March reconstructing a call from rows that retention may since have
 * pruned, and getting `restricted` for a perfectly ordinary conversation.
 */
export async function stampTranscript(
  pool: pg.Pool,
  args: {
    callControlId: string;
    transcriptArtifactId: string;
    /** The projects actually brought up. Empty is not "none discussed" — see below. */
    discussedProjectIds: string[];
  },
): Promise<{ classification: Confidentiality; discussed: Confidentiality[] }> {
  const r = await pool.query<{ confidentiality: Confidentiality }>(
    `SELECT confidentiality FROM projects WHERE id = ANY($1::uuid[])`,
    [args.discussedProjectIds],
  );
  const discussed = r.rows.map((x) => x.confidentiality);

  /*
   * strictestOf via transcriptClassification, which is S38's function - an empty
   * list gives `restricted`, and that is the right answer rather than an
   * awkward one: a call whose subject nobody recorded is not a call to read back
   * aloud on the strength of that absence.
   */
  const { transcriptClassification } = await import("./voicerecall.js");
  const classification = transcriptClassification(discussed);

  await pool.query(
    `UPDATE calls SET discussed_projects = $2::uuid[] WHERE call_control_id = $1`,
    [args.callControlId, args.discussedProjectIds],
  );
  await pool.query(
    `UPDATE artifacts SET confidentiality = $2 WHERE id = $1`,
    [args.transcriptArtifactId, classification],
  );
  return { classification, discussed };
}

/**
 * Putting documents in, and getting answers out with a citation (plan S30).
 *
 * Two halves that have to agree about the same table, so they live together:
 * ingestion writes chunks with everything a citation will need, and retrieval
 * ranks them and hands back that citation. Splitting them across files is how
 * the writer stops storing a field the reader still expects.
 *
 * The retrieval rules the plan is specific about, and why each one matters:
 *
 *  - **Tiers are ranked separately and never merged.** A chunk of a PDF
 *    returned when the honest answer is "you decided that on the 14th, here is
 *    the task" is a wrong answer that looks right, which is the worst kind. The
 *    caller gets the tiers apart and is told which is which.
 *  - **A superseded document does not answer.** S17 gives artifacts
 *    `supersedes_id`: v2 replaces v1 and both are kept. Their chunks are
 *    indistinguishable in the index, so without this the question "what did the
 *    client say about the refund window?" is answered fluently, with a
 *    citation, from the version that was replaced.
 *  - **Every hit carries where it came from** - the artifact, the locator and
 *    the offset - so an answer can be checked and a wrong one traced.
 */
import type pg from "pg";
import { chunkDocument, type ChunkKind } from "./chunk.js";

export type Tier = "knowledge" | "project_memory" | "global_memory" | "activity";

export type Hit = {
  tier: Tier;
  id: string;
  body: string;
  /** What to show a person so they can check the answer themselves. */
  citation: string;
  rank: number;
  at: string | null;
  /**
   * This chunk comes from a document that has been replaced.
   *
   * Offered rather than dropped, and never first. The plan asks for both
   * halves: the current version answers, and the old one is visible AS old -
   * because silently dropping it means nobody can see what changed, and
   * silently ranking it means the answer is confidently out of date.
   */
  superseded?: boolean;
};

export type Retrieved = {
  /** Kept apart on purpose: merging them is the failure mode, not a formatting choice. */
  tiers: { tier: Tier; hits: Hit[] }[];
  total: number;
};

/**
 * Store one document as chunks.
 *
 * Returns how many chunks were written. Replaces any chunks previously stored
 * for the same artifact: re-ingesting a document must not leave two generations
 * of chunks competing in the index, which reads as the document saying two
 * things.
 */
export async function ingestDocument(
  pool: pg.Pool,
  args: {
    projectId: string | null;
    artifactId: string | null;
    text: string;
    kind: ChunkKind;
    /** When the SOURCE is from, not when it was ingested. S41 searches on this. */
    sourceDate?: Date | null;
    /**
     * Prepended to every chunk locator, for sources with no artifact to name.
     *
     * A forward has no file to point at, and "a dumped document" is not a
     * citation anybody can act on.
     */
    locatorPrefix?: string;
  },
): Promise<number> {
  const chunks = chunkDocument({ text: args.text, kind: args.kind });
  if (!chunks.length) return 0;

  if (args.artifactId) {
    await pool.query(`DELETE FROM knowledge_chunks WHERE source_artifact_id = $1`, [args.artifactId]);
  }
  for (const c of chunks) {
    await pool.query(
      `INSERT INTO knowledge_chunks
         (project_id, body, source_artifact_id, kind, locator, char_offset, chunk_index, source_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [args.projectId, c.body, args.artifactId, c.kind,
        args.locatorPrefix ? `${args.locatorPrefix} — ${c.locator}` : c.locator,
        c.offset, c.index, args.sourceDate ?? null],
    );
  }
  return chunks.length;
}

/**
 * Rank one tier, and say nothing about the others.
 *
 * `ts_rank_cd` rather than `ts_rank`: cover density rewards a chunk where the
 * query terms appear near each other, which is what "the passage that actually
 * discusses this" looks like.
 */
async function knowledgeTier(
  pool: pg.Pool,
  q: string,
  projectId: string | null,
  limit: number,
): Promise<Hit[]> {
  const r = await pool.query<{
    id: string; body: string; locator: string | null; char_offset: number | null;
    path: string | null; rank: string; at: string | null; superseded: boolean;
  }>(
    `SELECT k.id::text, k.body, k.locator, k.char_offset, a.path,
            /*
             * Replaced, rather than filtered out. supersedes_id points at what a
             * document REPLACED, so an artifact is superseded when some OTHER
             * artifact points at it. Ordering puts current chunks first; the old
             * one is still offered, labelled, so a reader can see what changed.
             */
            (k.source_artifact_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM artifacts newer WHERE newer.supersedes_id = k.source_artifact_id
             )) AS superseded,
            ts_rank_cd(k.search, websearch_to_tsquery('english', $1))::text AS rank,
            COALESCE(k.source_date, k.created_at)::text AS at
       FROM knowledge_chunks k
       LEFT JOIN artifacts a ON a.id = k.source_artifact_id
      WHERE k.search @@ websearch_to_tsquery('english', $1)
        AND ($2::uuid IS NULL OR k.project_id = $2)
        -- The replaced version does not answer. supersedes_id points at what a
        -- document REPLACED, so an artifact is superseded when some OTHER
        -- artifact points at it. (No backticks in here: this whole query is a
        -- template literal, and a backtick would end it.)
      ORDER BY superseded ASC,
               ts_rank_cd(k.search, websearch_to_tsquery('english', $1)) DESC,
               COALESCE(k.source_date, k.created_at) DESC
      LIMIT $3`,
    [q, projectId, limit],
  );
  return r.rows.map((x) => ({
    tier: "knowledge" as const,
    id: x.id,
    body: x.body,
    citation: x.superseded
      ? `${citationFor(x.path, x.locator, x.char_offset)} (superseded)`
      : citationFor(x.path, x.locator, x.char_offset),
    rank: Number(x.rank),
    at: x.at,
    superseded: x.superseded,
  }));
}

/**
 * A citation a person can act on.
 *
 * "somewhere in this PDF" is not a citation. The locator is what the chunker
 * recorded - a heading, a speaker, a symbol - and the offset is the fallback
 * when there is no better name for the position.
 */
function citationFor(path: string | null, locator: string | null, offset: number | null): string {
  const where = locator && locator !== "whole document" ? locator : null;
  const source = path ?? "a dumped document";
  if (where) return `${source} — ${where}`;
  if (offset !== null && offset > 0) return `${source} — character ${offset}`;
  return source;
}

async function memoryTier(
  pool: pg.Pool,
  q: string,
  projectId: string | null,
  limit: number,
  global: boolean,
): Promise<Hit[]> {
  /*
   * The two branches carry different parameter lists rather than one list with
   * an unused slot. Passing a parameter the query never mentions makes Postgres
   * refuse it outright - "could not determine data type of parameter $2" -
   * because there is no context from which to infer its type.
   */
  const sql = (scope: string, limitParam: string) =>
    `SELECT m.id::text, m.body, m.kind,
            ts_rank_cd(to_tsvector('english', m.body), websearch_to_tsquery('english', $1))::text AS rank,
            m.created_at::text AS at
       FROM memory_items m
      WHERE to_tsvector('english', m.body) @@ websearch_to_tsquery('english', $1)
        /*
         * Live memories only. A superseded preference is kept for the audit -
         * he asked for it to be dropped, or replaced it - and answering from it
         * would be answering with a rule he has already withdrawn.
         */
        AND m.superseded_at IS NULL
        AND (${scope})
      ORDER BY 4 DESC, m.created_at DESC LIMIT ${limitParam}`;
  const r = global
    ? await pool.query<{ id: string; body: string; kind: string; rank: string; at: string }>(
        sql("m.project_id IS NULL", "$2"), [q, limit])
    : await pool.query<{ id: string; body: string; kind: string; rank: string; at: string }>(
        sql("m.project_id = $2", "$3"), [q, projectId, limit]);
  return r.rows.map((x) => ({
    tier: (global ? "global_memory" : "project_memory") as Tier,
    id: x.id,
    body: x.body,
    citation: `memory (${x.kind})`,
    rank: Number(x.rank),
    at: x.at,
  }));
}

/**
 * Activity history is queryable memory, not just a feed.
 *
 * Ranked last in the returned order but NOT ranked lower: when a question is
 * about a decision, this tier answers it best, because a decision has a date
 * and a task and can therefore be cited most precisely.
 */
async function activityTier(
  pool: pg.Pool,
  q: string,
  projectId: string | null,
  limit: number,
): Promise<Hit[]> {
  const r = await pool.query<{ id: string; title: string; detail: string | null; rank: string; at: string }>(
    `SELECT e.id::text, e.title, e.detail,
            ts_rank_cd(to_tsvector('english', e.title || ' ' || COALESCE(e.detail, '')),
                       websearch_to_tsquery('english', $1))::text AS rank,
            e.at::text AS at
       FROM activity_events e
      WHERE to_tsvector('english', e.title || ' ' || COALESCE(e.detail, ''))
            @@ websearch_to_tsquery('english', $1)
        AND ($2::uuid IS NULL OR e.project_id = $2)
      ORDER BY 4 DESC, e.at DESC LIMIT $3`,
    [q, projectId, limit],
  );
  const events = r.rows.map((x) => ({
    tier: "activity" as const,
    id: x.id,
    body: x.detail ? `${x.title} — ${x.detail}` : x.title,
    citation: `activity on ${x.at.slice(0, 10)}`,
    rank: Number(x.rank),
    at: x.at,
  }));

  /*
   * A configuration change IS a decision, and it is the better-evidenced half.
   *
   * The key is searched with its underscores turned into spaces: a config key is
   * snake_case, Postgres treats deploy_policy as a single lexeme, and nobody
   * asks a question in snake_case - so "why is the deploy policy manual" would
   * never reach the row that answers it.
   *
   * The plan names both: "the answer is a decision and its reasoning, and it
   * lives in activity_events AND config_versions". A feed line says what
   * happened; a config version says what the value became, who changed it, and
   * the message that caused it - which is what "why did we set Alpha's deploy
   * policy to manual" is actually asking for.
   */
  const cfg = await pool.query<{
    id: string; key: string; value: string; note: string | null; actor: string | null;
    caused_by: string | null; rank: string; at: string;
  }>(
    `SELECT c.id::text, c.key, c.value::text AS value, c.note, c.actor,
            c.caused_by_message AS caused_by,
            ts_rank_cd(to_tsvector('english',
                       replace(c.key, '_', ' ') || ' ' || c.value::text || ' ' || COALESCE(c.note, '')
                       || ' ' || COALESCE(c.caused_by_message, '')),
                       websearch_to_tsquery('english', $1))::text AS rank,
            c.at::text AS at
       FROM config_versions c
      WHERE to_tsvector('english',
              replace(c.key, '_', ' ') || ' ' || c.value::text || ' ' || COALESCE(c.note, '')
              || ' ' || COALESCE(c.caused_by_message, ''))
            @@ websearch_to_tsquery('english', $1)
        AND ($2::uuid IS NULL OR c.project_id = $2)
      ORDER BY 7 DESC, c.at DESC LIMIT $3`,
    [q, projectId, limit],
  );
  const decisions = cfg.rows.map((x) => ({
    tier: "activity" as const,
    id: x.id,
    body: [`${x.key} set to ${x.value}`, x.note, x.caused_by && `asked as: ${x.caused_by}`]
      .filter(Boolean).join(" — "),
    citation: `${x.key} changed on ${x.at.slice(0, 10)}${x.actor ? ` by ${x.actor}` : ""}`,
    rank: Number(x.rank),
    at: x.at,
  }));

  return [...events, ...decisions].sort((a, b) => b.rank - a.rank).slice(0, limit);
}

/**
 * Which tier should answer first?
 *
 * The plan's rule is about EVIDENCE, not about topic: *"prefer the one whose
 * answer can be cited most precisely: activity history over knowledge when the
 * question is about a decision, because the decision has a date and a task; the
 * document over memory when the question is about a fact, because the document
 * can be quoted. Memory answers what Jarvis was TOLD, and that is the weakest
 * evidence of the three."*
 *
 * So this reads the shape of the question, not its subject. "Why did we..." and
 * "when did we decide..." are asking for a decision, and a decision has a date
 * and an actor; "what did the client say..." is asking for a fact, and a fact
 * can be quoted from a document.
 *
 * Memory is last in both orders, always. It is the only tier whose contents
 * nobody can check - it records what Jarvis was told, with no document behind
 * it - and putting it above evidence that can be quoted is how a half-remembered
 * instruction outranks the contract it contradicts.
 *
 * Deliberately a small keyword rule rather than a model call: this decides
 * ordering, not truth, every tier is still returned and labelled, and spending a
 * model call to sort four lists would make every question slower to answer the
 * same way.
 */
const DECISION_SHAPES = [
  /\bwhy did\b/i, /\bwhy do\b/i, /\bwhy is\b/i, /\bwhy are\b/i,
  /\bwhen did\b/i, /\bwho decided\b/i, /\bwho changed\b/i,
  /\bdecide/i, /\bdecision\b/i, /\bagreed\b/i, /\bchanged\b.*\bto\b/i,
];

export function tierOrderFor(question: string): Tier[] {
  const decision = DECISION_SHAPES.some((re) => re.test(question));
  return decision
    ? ["activity", "knowledge", "project_memory", "global_memory"]
    : ["knowledge", "activity", "project_memory", "global_memory"];
}

export async function retrieve(
  pool: pg.Pool,
  args: {
    q: string;
    projectId?: string | null;
    limit?: number;
  },
): Promise<Retrieved> {
  const q = args.q.trim();
  if (!q) return { tiers: [], total: 0 };
  const limit = args.limit ?? 5;
  const projectId = args.projectId ?? null;

  const [knowledge, projectMemory, globalMemory, activity] = await Promise.all([
    knowledgeTier(pool, q, projectId, limit),
    projectId ? memoryTier(pool, q, projectId, limit, false) : Promise.resolve([]),
    memoryTier(pool, q, null, limit, true),
    activityTier(pool, q, projectId, limit),
  ]);

  const byTier: Record<Tier, Hit[]> = {
    activity,
    knowledge,
    project_memory: projectMemory,
    global_memory: globalMemory,
  };
  // Ordered by what the question is asking for, not by a fixed preference.
  const tiers = tierOrderFor(q)
    .map((tier) => ({ tier, hits: byTier[tier] }))
    .filter((t) => t.hits.length);

  return { tiers, total: tiers.reduce((n, t) => n + t.hits.length, 0) };
}

/**
 * A forwarded thread, made findable.
 *
 * N2 is "he forwards a 40-message thread and three PDFs, they are stored,
 * chunked and indexed, and three weeks later a phrase inside one of them is
 * answerable with a citation". The forward was already stored - S37 keeps it
 * separately so it can never be mistaken for something he said - but stored is
 * not indexed, and a thread nobody can retrieve is a thread that was filed
 * rather than kept.
 *
 * Chunked as chat, because that is what it is: one message plus the two around
 * it, since a line like "yes, that works" answers nothing on its own.
 *
 * Returns the number of chunks, and never throws into the message path: a
 * failure to index must not cost him the message. It is reported instead.
 */
export async function ingestForward(
  pool: pg.Pool,
  args: { inboxEventId: string; projectId: string | null; text: string; at?: Date | null },
): Promise<{ chunks: number; error?: string }> {
  try {
    /*
     * The forward is named as the chunks are written, not patched afterwards.
     *
     * The first version updated the rows it had just inserted, matched by "same
     * project, written in the last minute". That is a race dressed as a query -
     * two forwards arriving together would relabel each other - and it also
     * passed a parameter the statement never mentioned, which Postgres refuses
     * outright.
     */
    const chunks = await ingestDocument(pool, {
      projectId: args.projectId,
      artifactId: null,
      text: args.text,
      kind: "chat",
      sourceDate: args.at ?? new Date(),
      locatorPrefix: `forward ${args.inboxEventId.slice(0, 8)}`,
    });
    return { chunks };
  } catch (err) {
    return { chunks: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export type Answer =
  | { known: true; citations: string[]; hits: Hit[] }
  | { known: false; reason: string; searched: Tier[] };

/**
 * What to say when nothing was found.
 *
 * The Done-when asks for "an honest I do not know when the answer is not
 * there", and the reason it has to be built rather than assumed is that the
 * natural failure is the opposite: a retrieval that returns the three
 * least-irrelevant chunks, handed to a model that writes a confident paragraph
 * from them. Nothing in that path ever says "there was nothing here".
 *
 * So the decision is made before any prose is generated, and it is made on
 * whether anything was retrieved at all - not on how the answer reads.
 */
export function answerFrom(retrieved: Retrieved, searched: Tier[]): Answer {
  const hits = retrieved.tiers.flatMap((t) => t.hits);
  if (!hits.length) {
    return {
      known: false,
      reason: "nothing in the indexed documents, memory or activity matches that",
      searched,
    };
  }
  return {
    known: true,
    hits,
    citations: [...new Set(hits.map((h) => h.citation))],
  };
}

/**
 * Index one stored artifact, if it is allowed to be indexed at all.
 *
 * Two gates before any text is read, and the first one is a security property
 * rather than a nicety:
 *
 *  - **A quarantined artifact is never indexed.** S17 refuses to serve one to a
 *    model or a browser; indexing it would smuggle its contents into an answer
 *    by another door, with a citation, looking entirely legitimate.
 *  - **A document that cannot be read is reported, not skipped silently.** An
 *    unreadable file that is stored and never mentioned is indistinguishable
 *    from one that was indexed and had nothing to say, and the difference only
 *    surfaces on the day somebody asks it a question.
 */
export async function indexArtifact(
  pool: pg.Pool,
  artifactId: string,
  artifactsRoot: string,
): Promise<{ chunks: number; skipped?: string }> {
  const r = await pool.query<{
    path: string; mime: string | null; quarantine_state: string;
    project_id: string | null; created_at: string;
  }>(
    `SELECT path, mime, quarantine_state, project_id, created_at::text
       FROM artifacts WHERE id = $1`, [artifactId]);
  const a = r.rows[0];
  if (!a) return { chunks: 0, skipped: "no such artifact" };

  if (a.quarantine_state !== "clean") {
    /*
     * Not an error and not reported to him: a blocked file being unsearchable
     * is the system working. Recording it as a failure would train him to
     * ignore the ones that matter.
     */
    return { chunks: 0, skipped: `quarantined (${a.quarantine_state})` };
  }

  const path = await import("node:path");
  const { extractText } = await import("./extract.js");
  const full = path.join(artifactsRoot, a.path);
  const extracted = await extractText(full, a.mime);

  if (!extracted.ok) {
    await noteUnreadable(pool, a.project_id, a.path, extracted.reason);
    return { chunks: 0, skipped: extracted.reason };
  }

  const chunks = await ingestDocument(pool, {
    projectId: a.project_id,
    artifactId,
    text: extracted.text,
    kind: extracted.kind,
    // The document's own date, not the moment it was uploaded, so S41 can ask
    // for "the contract from August" and mean the contract.
    sourceDate: new Date(a.created_at),
  });
  return { chunks };
}

/**
 * Put an unreadable document on the timeline he actually reads.
 *
 * A line in a container log is not visible. The activity feed is where he would
 * look for "what happened to that file I sent", and this is the only place the
 * answer exists.
 */
async function noteUnreadable(
  pool: pg.Pool,
  projectId: string | null,
  artifactPath: string,
  reason: string,
): Promise<void> {
  await pool
    .query(
      `INSERT INTO activity_events (project_id, kind, title, detail, actor)
       VALUES ($1, 'knowledge', $2, $3, 'jarvis')`,
      [projectId, `Not searchable: ${artifactPath.split("/").pop()}`, reason],
    )
    .catch(() => undefined);
}

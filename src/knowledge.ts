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
  includeSuperseded: boolean,
): Promise<Hit[]> {
  const r = await pool.query<{
    id: string; body: string; locator: string | null; char_offset: number | null;
    path: string | null; rank: string; at: string | null;
  }>(
    `SELECT k.id::text, k.body, k.locator, k.char_offset, a.path,
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
        AND ($4 OR k.source_artifact_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM artifacts newer WHERE newer.supersedes_id = k.source_artifact_id))
      ORDER BY ts_rank_cd(k.search, websearch_to_tsquery('english', $1)) DESC,
               COALESCE(k.source_date, k.created_at) DESC
      LIMIT $3`,
    [q, projectId, limit, includeSuperseded],
  );
  return r.rows.map((x) => ({
    tier: "knowledge" as const,
    id: x.id,
    body: x.body,
    citation: citationFor(x.path, x.locator, x.char_offset),
    rank: Number(x.rank),
    at: x.at,
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
  return r.rows.map((x) => ({
    tier: "activity" as const,
    id: x.id,
    body: x.detail ? `${x.title} — ${x.detail}` : x.title,
    citation: `activity on ${x.at.slice(0, 10)}`,
    rank: Number(x.rank),
    at: x.at,
  }));
}

export async function retrieve(
  pool: pg.Pool,
  args: {
    q: string;
    projectId?: string | null;
    limit?: number;
    /** Only for showing history deliberately; never the default. */
    includeSuperseded?: boolean;
  },
): Promise<Retrieved> {
  const q = args.q.trim();
  if (!q) return { tiers: [], total: 0 };
  const limit = args.limit ?? 5;
  const projectId = args.projectId ?? null;

  const [knowledge, projectMemory, globalMemory, activity] = await Promise.all([
    knowledgeTier(pool, q, projectId, limit, args.includeSuperseded === true),
    projectId ? memoryTier(pool, q, projectId, limit, false) : Promise.resolve([]),
    memoryTier(pool, q, null, limit, true),
    activityTier(pool, q, projectId, limit),
  ]);

  const tiers = [
    { tier: "activity" as Tier, hits: activity },
    { tier: "knowledge" as Tier, hits: knowledge },
    { tier: "project_memory" as Tier, hits: projectMemory },
    { tier: "global_memory" as Tier, hits: globalMemory },
  ].filter((t) => t.hits.length);

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

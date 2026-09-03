/**
 * Filing a scrape: an artifact with a source, never a memory (plan S32).
 *
 *   "A scrape becomes an artifact with a source, **never memory**. Memory is
 *    what Enrique told Jarvis; the web is a citation, not a belief."
 *
 * That sentence is the whole design. The two stores answer different questions
 * and a scrape belongs in exactly one of them: `memory_items` holds statements
 * he made, and everything in it is treated as authoritative because he said it.
 * A product page in there is a stranger's claim wearing his authority - and
 * three weeks later nothing about the row says which it was.
 *
 * So this module writes chunks and artifacts and has no route to memory at all.
 * Not a rule against it: there is no import, and the suite asserts the memory
 * table is untouched across a whole scrape rather than trusting the absence.
 *
 * The second half is the plan's "output is an artifact, not a log line:
 * structured data plus the raw pages it came from, so a wrong result can be
 * diagnosed without re-scraping". Keeping the pages is what makes a wrong
 * selector a five-minute question instead of another 14,000 requests - and the
 * pages are what the site actually served, which stops being knowable the
 * moment it changes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { ingestDocument } from "./knowledge.js";
import { ARTIFACTS_DIR } from "./paths.js";

export type ScrapeFiling = {
  /** The structured rows, as one artifact. */
  dataArtifactId: string;
  /** One per page fetched, so a wrong result is diagnosable without re-scraping. */
  pageArtifactIds: string[];
  chunks: number;
};

/**
 * Store what a scrape produced.
 *
 * `originUrl` is required rather than optional. An optional origin is one that
 * a caller forgets on the path that matters, and a scraped artifact without one
 * cites exactly like a document he wrote - which is the single failure this
 * whole file exists to prevent.
 */
export async function fileScrapeRun(
  pool: pg.Pool,
  args: {
    projectId: string;
    originUrl: string;
    rows: Record<string, string>[];
    snapshots: { url: string; html: string }[];
    taskId?: string | null;
    root?: string;
  },
): Promise<ScrapeFiling> {
  if (!args.originUrl) throw new Error("a scraped artifact without an origin cites like something he wrote");
  const root = args.root ?? ARTIFACTS_DIR;
  const dir = path.join(root, args.projectId);
  await fs.mkdir(dir, { recursive: true, mode: 0o750 });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const host = safeHost(args.originUrl);

  const dataName = `scrape-${host}-${stamp}.json`;
  await fs.writeFile(path.join(dir, dataName), JSON.stringify(args.rows, null, 2));
  const dataArtifactId = await record(pool, {
    projectId: args.projectId, rel: `${args.projectId}/${dataName}`,
    mime: "application/json", originUrl: args.originUrl, taskId: args.taskId ?? null,
  });

  /*
   * The raw pages, each with the URL it came from as its own origin rather than
   * the run's start URL. Page 37's origin is page 37: an artifact that says it
   * came from the first page of a listing sends whoever is diagnosing it to the
   * wrong document.
   */
  const pageArtifactIds: string[] = [];
  for (const [n, snap] of args.snapshots.entries()) {
    const name = `scrape-${host}-${stamp}-page-${String(n + 1).padStart(4, "0")}.html`;
    await fs.writeFile(path.join(dir, name), snap.html);
    pageArtifactIds.push(await record(pool, {
      projectId: args.projectId, rel: `${args.projectId}/${name}`,
      mime: "text/html", originUrl: snap.url, taskId: args.taskId ?? null,
    }));
  }

  /*
   * Indexed as the structured rows rather than as raw HTML. The pages are kept
   * for diagnosis, and indexing them too would fill retrieval with navigation
   * chrome and cookie banners that outrank the data on any query mentioning a
   * word the template happens to use.
   */
  const asText = args.rows
    .map((r) => Object.entries(r).map(([k, v]) => `${k}: ${v}`).join("\n"))
    .join("\n\n");
  const chunks = asText.trim()
    ? await ingestDocument(pool, {
      projectId: args.projectId,
      artifactId: dataArtifactId,
      text: asText,
      kind: "table",
      sourceDate: new Date(),
    })
    : 0;

  return { dataArtifactId, pageArtifactIds, chunks };
}

async function record(
  pool: pg.Pool,
  a: { projectId: string; rel: string; mime: string; originUrl: string; taskId: string | null },
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO artifacts (project_id, path, mime, quarantine_state, artifact_type, origin_url, task_id)
     VALUES ($1,$2,$3,'clean','dataset',$4,$5) RETURNING id`,
    [a.projectId, a.rel, a.mime, a.originUrl, a.taskId],
  );
  return r.rows[0].id;
}

/** A host, usable as part of a filename. */
function safeHost(url: string): string {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = "unknown";
  }
  return host.replace(/[^a-z0-9.-]/gi, "_").slice(0, 60) || "unknown";
}

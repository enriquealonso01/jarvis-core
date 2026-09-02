import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { installLogScrubber, scrubString } from "./scrubber.js";

export function createPool(): pg.Pool {
  let url = process.env.DATABASE_URL;
  if (!url) {
    const password = process.env.POSTGRES_PASSWORD;
    if (!password) {
      throw new Error("DATABASE_URL or POSTGRES_PASSWORD is required");
    }
    url = `postgres://jarvis:${encodeURIComponent(password)}@postgres:5432/jarvis`;
  }
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  installLogScrubber();
  return scrubbed(pool);
}

/**
 * Every string bound into every statement passes the scrubber (Part V).
 *
 * The plan asks for four exits to be filtered — log lines, issue evidence,
 * audit metadata and artifacts. Three of those four are rows, written from a
 * dozen call sites, and a filter applied at a dozen call sites is a filter that
 * is missing from the thirteenth. Here it is applied once, to the only door all
 * of them go through.
 *
 * Only string PARAMETERS are touched. The SQL text is left alone, and so are
 * Buffers — which is what a credential's own ciphertext is, so storing a secret
 * still works while writing one into a log line does not.
 */
function scrubbed(pool: pg.Pool): pg.Pool {
  const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { query: (...args: unknown[]) => unknown }).query = (
    ...args: unknown[]
  ) => {
    const values = args[1];
    if (Array.isArray(values)) {
      args[1] = values.map((v) => (typeof v === "string" ? scrubString(v) : v));
    } else if (args[0] && typeof args[0] === "object" && Array.isArray((args[0] as { values?: unknown[] }).values)) {
      const config = args[0] as { values: unknown[] };
      config.values = config.values.map((v) => (typeof v === "string" ? scrubString(v) : v));
    }
    return original(...args);
  };
  return pool;
}

/**
 * A standalone connection, outside the pool.
 *
 * LISTEN belongs to a session, and a pooled connection is handed back the
 * moment the query returns — taking the subscription with it and leaving a
 * listener that never hears anything. It reconnects itself, because a dropped
 * notification channel is silent: nothing errors, the console simply stops
 * updating and looks like a system with nothing to say.
 */
export async function connectClient(): Promise<pg.Client> {
  let url = process.env.DATABASE_URL;
  if (!url) {
    const password = process.env.POSTGRES_PASSWORD;
    if (!password) throw new Error("DATABASE_URL or POSTGRES_PASSWORD is required");
    url = `postgres://jarvis:${encodeURIComponent(password)}@postgres:5432/jarvis`;
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const dir = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const applied = new Set(
    (await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map(
      (r) => r.filename,
    ),
  );
  const files = (await fs.readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

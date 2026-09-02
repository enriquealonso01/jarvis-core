import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

export function createPool(): pg.Pool {
  let url = process.env.DATABASE_URL;
  if (!url) {
    const password = process.env.POSTGRES_PASSWORD;
    if (!password) {
      throw new Error("DATABASE_URL or POSTGRES_PASSWORD is required");
    }
    url = `postgres://jarvis:${encodeURIComponent(password)}@postgres:5432/jarvis`;
  }
  return new pg.Pool({ connectionString: url, max: 8 });
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

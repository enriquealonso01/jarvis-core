import type pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { ARTIFACTS_DIR } from "./paths.js";

const ARTIFACTS = ARTIFACTS_DIR;

/**
 * Raw audio is deleted after seven days; the transcript is what survives
 * (§80.2 / L12, and S24's Done-when).
 *
 * Moved out of the worker so a test can run THE JOB rather than a copy of it.
 * It lived inside `worker.ts`, which starts the worker loop on import, so the
 * only way to test it was to reimplement it — and a reimplementation is a test
 * of the reimplementation.
 */
export async function audioRetention(pool: pg.Pool): Promise<void> {

  const expired = await pool.query<{ id: string; path: string; project_id: string | null }>(
    `SELECT id, path, project_id FROM artifacts
     WHERE retention_class = 'raw_audio' AND permanent = false
       AND retain_until IS NOT NULL AND retain_until < now()`,
  );
  for (const a of expired.rows) {
    const full = path.join(ARTIFACTS, a.path);
    await fs.unlink(full).catch(() => undefined);
    await pool.query(`DELETE FROM artifacts WHERE id = $1`, [a.id]);
  }
  const breach = await pool.query(
    `SELECT 1 FROM artifacts
     WHERE retention_class = 'raw_audio' AND permanent = false
       AND created_at < now() - interval '10 days' LIMIT 1`,
  );
  if ((breach.rowCount ?? 0) > 0) {
    await pool.query(
      `INSERT INTO issues (severity, category, service, status, owner, title, dedupe_key)
       SELECT 'critical', 'security.retention_breach', 'retention', 'open', 'jarvis',
              '[retention] raw audio older than 10 days', 'sec.retention'
       WHERE NOT EXISTS (
         SELECT 1 FROM issues WHERE dedupe_key = 'sec.retention' AND status NOT IN ('resolved','ignored')
       )`,
    );
  }
}

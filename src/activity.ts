import type pg from "pg";

/**
 * The two writers behind S18's activity feed and resource trend.
 *
 * A leaf module on purpose. These are called from `transitionTask`, `createTask`
 * and `recordArtifact` — the hottest paths in the system — and importing them
 * from `search.ts` dragged the whole route surface, `requireUser` and everything
 * it touches into the runner for the sake of one INSERT.
 */

/** Write one line into the feed. Never throws — a feed is not worth a 500. */
export async function recordActivity(
  pool: pg.Pool,
  args: {
    projectId?: string | null;
    kind: string;
    subjectId?: string | null;
    title: string;
    detail?: string | null;
    actor?: string;
    href?: string | null;
  },
): Promise<void> {
  await pool
    .query(
      `INSERT INTO activity_events (project_id, kind, subject_id, title, detail, actor, href)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        args.projectId ?? null,
        args.kind,
        args.subjectId ?? null,
        args.title.slice(0, 300),
        args.detail?.slice(0, 1000) ?? null,
        args.actor ?? "jarvis",
        args.href ?? null,
      ],
    )
    .catch(() => undefined);
}

/** One sample of what the box is doing, for the trend above. */
export async function sampleResources(
  pool: pg.Pool,
  host: {
    cpu?: { busy_pct?: number; load1?: number };
    memory?: { used_pct?: number };
    disk?: { used_pct?: number; free_bytes?: number } | null;
  } | null,
): Promise<void> {
  if (!host) return;
  await pool
    .query(
      `INSERT INTO resource_metrics (cpu_busy_pct, memory_used_pct, disk_used_pct, disk_free_bytes, load1)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        host.cpu?.busy_pct ?? null,
        host.memory?.used_pct ?? null,
        host.disk?.used_pct ?? null,
        host.disk?.free_bytes ?? null,
        host.cpu?.load1 ?? null,
      ],
    )
    .catch(() => undefined);
}

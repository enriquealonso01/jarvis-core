import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { requireUser } from "./auth.js";
import { ARTIFACTS_DIR } from "./paths.js";
import { sseBroadcast } from "./sse.js";
import { createTask } from "./work.js";

/**
 * Artifacts as first-class objects (plan S17).
 *
 * "This is the mechanism by which Enrique controls the QUALITY of what Jarvis
 * produces, rather than only whether it ran." Everything here follows from that
 * sentence: a review state that means something, a version history that cannot
 * be destroyed by a second attempt, and a rejection that is a work instruction
 * rather than a status change.
 */

const ORIGIN = process.env.JARVIS_ORIGIN ?? "https://jarvis.enriquecodes.com";

function originOk(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (origin) return origin === ORIGIN;
  return true;
}

export const ARTIFACT_TYPES = [
  "pull_request",
  "commit",
  "patch",
  "report",
  "document",
  "spreadsheet",
  "screenshot",
  "dataset",
  "download",
  "test_report",
  "recording",
  "deployment_url",
] as const;

/**
 * The state machine from the plan, as data.
 *
 *   draft -> generated -> under_review -> ready -> approved -> delivered
 *                              |                      |
 *                          rejected              superseded
 *
 * `superseded` is reachable from anywhere: a second attempt at an output can
 * arrive while the first is still under review, and the first must become
 * history rather than vanish.
 */
const NEXT: Record<string, string[]> = {
  draft: ["generated", "superseded"],
  generated: ["under_review", "superseded"],
  under_review: ["ready", "rejected", "superseded"],
  ready: ["approved", "rejected", "superseded"],
  approved: ["delivered", "superseded"],
  delivered: ["superseded"],
  rejected: ["superseded"],
  superseded: [],
};

export function canTransition(from: string, to: string): boolean {
  return (NEXT[from] ?? []).includes(to);
}

/** Nothing outside the artifacts directory is ever readable through this. */
function safeArtifactPath(rel: string): string | null {
  const full = path.resolve(ARTIFACTS_DIR, rel);
  const root = path.resolve(ARTIFACTS_DIR);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

/**
 * Record an artifact WITH its provenance, in one call.
 *
 * The plan's Debug section: "If an artifact shows no creator, the run recorded
 * the file but not the provenance — check the registration call, not the page.
 * Provenance written later is provenance that will sometimes be missing." So
 * there is one way in, and it takes the creator as an argument rather than
 * offering to fill it in afterwards.
 *
 * Supersession is EXPLICIT: pass the id of the artifact this one replaces. The
 * first version of this inferred it from a matching path, which is the same
 * mistake in a friendlier costume — two versions at one path means the second
 * write destroyed the first one's bytes, so the history existed and the
 * comparison it was for could never be done.
 */
export async function recordArtifact(
  pool: pg.Pool,
  args: {
    projectId: string | null;
    path: string;
    type: (typeof ARTIFACT_TYPES)[number];
    mime?: string | null;
    bytes?: number | null;
    sha256?: string | null;
    source?: string;
    quarantineState?: string;
    retentionClass?: string;
    externalUrl?: string | null;
    taskId?: string | null;
    conversationId?: string | null;
    agent?: string | null;
    model?: string | null;
    harness?: string | null;
    authProfile?: string | null;
    state?: string;
    /** The artifact this one replaces. Its path must differ — see below. */
    supersedes?: string | null;
  },
): Promise<{ id: string; version: number; supersedes: string | null }> {
  let previous: { id: string; version: number; path: string } | null = null;
  if (args.supersedes) {
    const prior = await pool.query<{ id: string; version: number; path: string }>(
      "SELECT id, version, path FROM artifacts WHERE id = $1",
      [args.supersedes],
    );
    previous = prior.rows[0] ?? null;
    if (!previous) throw new Error(`cannot supersede ${args.supersedes}: no such artifact`);
    /*
     * A new version must be a NEW FILE.
     *
     * Superseding a row while writing over the same path looks like versioning
     * and is not: v1's bytes are gone, so the two versions cannot be compared
     * and the review the history exists for is impossible. The plan says it
     * plainly — "an artifact overwritten in place rather than superseded has
     * already destroyed the evidence and no amount of UI work will bring it
     * back" — so this refuses rather than recording a lineage it cannot honour.
     */
    if (previous.path === args.path && !args.externalUrl) {
      throw new Error(
        `refusing to supersede ${previous.id} with the same path (${args.path}): `
        + "the previous version's bytes would be overwritten and the two could never be compared",
      );
    }
  }

  const r = await pool.query<{ id: string; version: number }>(
    `INSERT INTO artifacts
       (project_id, path, sha256, mime, bytes, source, quarantine_state, retention_class,
        artifact_type, state, version, supersedes_id, external_url,
        task_id, conversation_id,
        created_by_agent, created_by_model, created_by_harness, created_by_auth_profile)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING id, version`,
    [
      args.projectId,
      args.path,
      args.sha256 ?? null,
      args.mime ?? null,
      args.bytes ?? null,
      args.source ?? "jarvis",
      args.quarantineState ?? "clean",
      args.retentionClass ?? "other",
      args.type,
      args.state ?? "generated",
      (previous?.version ?? 0) + 1,
      previous?.id ?? null,
      args.externalUrl ?? null,
      args.taskId ?? null,
      args.conversationId ?? null,
      args.agent ?? null,
      args.model ?? null,
      args.harness ?? null,
      args.authProfile ?? null,
    ],
  );

  if (previous) {
    // The old one becomes history, not rubbish. Both rows stay.
    await pool.query(
      `UPDATE artifacts SET state = 'superseded' WHERE id = $1 AND state <> 'superseded'`,
      [previous.id],
    );
  }
  sseBroadcast("queue.updated", {});
  return { id: r.rows[0].id, version: r.rows[0].version, supersedes: previous?.id ?? null };
}

/** The whole lineage of one artifact, oldest first. */
export async function lineage(pool: pg.Pool, id: string): Promise<Record<string, unknown>[]> {
  const r = await pool.query(
    `WITH RECURSIVE back AS (
       SELECT * FROM artifacts WHERE id = $1
       UNION ALL
       SELECT a.* FROM artifacts a JOIN back b ON a.id = b.supersedes_id
     ), forward AS (
       SELECT * FROM artifacts WHERE id = $1
       UNION ALL
       SELECT a.* FROM artifacts a JOIN forward f ON a.supersedes_id = f.id
     )
     SELECT DISTINCT ON (id) id, path, artifact_type, state, version, bytes, sha256,
            created_at, reviewer_notes, reviewed_at, delivered_at, external_url
     FROM (SELECT * FROM back UNION SELECT * FROM forward) all_rows
     ORDER BY id, version`,
    [id],
  );
  return r.rows.sort((a, b) => Number(a.version) - Number(b.version));
}

export function registerArtifactRoutes(app: FastifyInstance, pool: pg.Pool) {
  /** One artifact, with everything the page needs to review it. */
  app.get("/api/artifacts/:id/detail", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const r = await pool.query(
      `SELECT a.*, p.slug AS project_slug, p.name AS project_name,
              t.title AS task_title, t.state AS task_state
       FROM artifacts a
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN tasks t ON t.id = a.task_id
       WHERE a.id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ error: "not found" });

    // A text artifact small enough to read gets a preview; everything else says
    // what it is instead. The plan: "Say 'no preview available' rather than
    // rendering nothing — a blank panel is indistinguishable from a broken one."
    let preview: string | null = null;
    let previewKind = "none";
    const textish =
      typeof row.mime === "string"
      && /^(text\/|application\/(json|x-ndjson|xml|csv))/.test(row.mime);
    if (row.external_url) {
      previewKind = "link";
    } else if (row.quarantine_state !== "clean") {
      previewKind = "quarantined";
    } else if (textish && Number(row.bytes ?? 0) <= 256 * 1024) {
      const full = safeArtifactPath(row.path);
      if (full) {
        preview = await fs.readFile(full, "utf8").then((s) => s.slice(0, 20_000)).catch(() => null);
        previewKind = preview === null ? "missing" : "text";
      }
    } else if (typeof row.mime === "string" && row.mime.startsWith("image/")) {
      previewKind = "image";
    }

    return {
      artifact: row,
      preview,
      preview_kind: previewKind,
      versions: await lineage(pool, id),
    };
  });

  /** The bytes, through a gate. */
  app.get("/api/artifacts/:id/download", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const r = await pool.query<{
      path: string; mime: string | null; quarantine_state: string; external_url: string | null;
    }>(
      "SELECT path, mime, quarantine_state, external_url FROM artifacts WHERE id = $1",
      [id],
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ error: "not found" });

    // A quarantined artifact cannot be downloaded AT ALL. Not with a warning,
    // not behind a confirm: the point of quarantine is that the bytes do not
    // leave until something has looked at them.
    if (row.quarantine_state !== "clean") {
      await pool.query(
        `INSERT INTO audit_events (actor, action, target, metadata)
         VALUES ('user', 'artifact.download_refused', $1, $2)`,
        [id, JSON.stringify({ quarantine_state: row.quarantine_state })],
      );
      return reply.code(403).send({
        error: {
          code: "quarantined",
          message: `this artifact is ${row.quarantine_state}; it cannot be downloaded until it is cleared`,
        },
      });
    }
    if (row.external_url) {
      return reply.code(409).send({
        error: { code: "not_a_file", message: "this artifact is a link, not a file" },
      });
    }

    const full = safeArtifactPath(row.path);
    if (!full) return reply.code(400).send({ error: "bad path" });
    const buf = await fs.readFile(full).catch(() => null);
    if (!buf) return reply.code(410).send({ error: "the file is no longer on disk" });

    await pool.query(
      `INSERT INTO audit_events (actor, action, target, metadata)
       VALUES ('user', 'artifact.download', $1, $2)`,
      [id, JSON.stringify({ bytes: buf.length })],
    );
    reply.header("Content-Type", row.mime ?? "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="${path.basename(row.path)}"`);
    return reply.send(buf);
  });

  /**
   * Move an artifact through its states.
   *
   * `reject` and `revise` both take a note, and both CREATE A TASK. The plan is
   * explicit that this is the point: "Rejecting an output with a note is a work
   * instruction, not a status change — it goes back to the queue against the
   * same project with the note attached, so the loop closes without Enrique
   * restating anything."
   */
  app.post("/api/artifacts/:id/review", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) return reply.code(403).send({ error: "bad origin" });
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { action?: string; note?: string; target?: string };
    const action = b.action ?? "";
    const note = (b.note ?? "").trim();

    const r = await pool.query<{
      id: string; state: string; path: string; project_id: string | null;
      artifact_type: string; task_id: string | null; version: number;
    }>(
      `SELECT id, state, path, project_id, artifact_type, task_id, version
       FROM artifacts WHERE id = $1`,
      [id],
    );
    const a = r.rows[0];
    if (!a) return reply.code(404).send({ error: "not found" });

    const TO: Record<string, string> = {
      start_review: "under_review",
      ready: "ready",
      approve: "approved",
      reject: "rejected",
      revise: "rejected",
      deliver: "delivered",
    };
    const to = TO[action];
    if (!to) return reply.code(400).send({ error: `unknown action ${action}` });

    if ((action === "reject" || action === "revise") && !note) {
      // A rejection with no note is a status change pretending to be feedback,
      // and it is the thing that makes the next attempt a guess.
      return reply.code(400).send({
        error: { code: "note_required", message: "say what is wrong with it — the note becomes the next task" },
      });
    }
    if (!canTransition(a.state, to)) {
      return reply.code(409).send({
        error: { code: "bad_transition", message: `an artifact that is ${a.state} cannot become ${to}` },
      });
    }

    await pool.query(
      `UPDATE artifacts
       SET state = $2,
           reviewer_notes = COALESCE(NULLIF($3, ''), reviewer_notes),
           reviewed_at = CASE WHEN $2 IN ('approved','rejected','ready') THEN now() ELSE reviewed_at END,
           delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END,
           delivery_target = COALESCE($4, delivery_target)
       WHERE id = $1`,
      [id, to, note, b.target ?? null],
    );

    let createdTask: string | null = null;
    if ((action === "reject" || action === "revise") && a.project_id) {
      createdTask = await createTask(pool, {
        projectId: a.project_id,
        conversationId: null,
        originInboxId: null,
        title: `Revise ${path.basename(a.path)}`,
        objective:
          `Enrique rejected version ${a.version} of ${a.path} and said:\n\n"${note}"\n\n`
          + "Produce a new version that answers that. The previous version stays as history — "
          + "register the new one rather than overwriting the old file.",
        lane: "heavy",
        priority: "high",
        cause: `artifact ${id} rejected on review`,
      });
    }

    await pool.query(
      `INSERT INTO audit_events (actor, action, target, project_id, metadata)
       VALUES ('user', $1, $2, $3, $4)`,
      [`artifact.${action}`, id, a.project_id, JSON.stringify({ to, note: note.slice(0, 500), task: createdTask })],
    );
    sseBroadcast("queue.updated", {});
    return { ok: true, state: to, task_id: createdTask };
  });

  /** Two versions, side by side. Text diffs as text; anything else by its facts. */
  app.get("/api/artifacts/:id/compare", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const other = (req.query as { with?: string }).with;
    if (!other) return reply.code(400).send({ error: "with=<artifact id> required" });

    const r = await pool.query(
      `SELECT id, path, mime, bytes, sha256, version, state, created_at, quarantine_state
       FROM artifacts WHERE id = ANY($1::uuid[])`,
      [[id, other]],
    );
    if (r.rows.length !== 2) return reply.code(404).send({ error: "not found" });
    const [a, b] = r.rows.sort((x, y) => Number(x.version) - Number(y.version)) as {
      id: string; path: string; mime: string | null; bytes: number | null; sha256: string | null;
      version: number; state: string; quarantine_state: string;
    }[];

    const readable = (row: typeof a) =>
      row.quarantine_state === "clean"
      && typeof row.mime === "string"
      && /^(text\/|application\/(json|x-ndjson|xml|csv))/.test(row.mime)
      && Number(row.bytes ?? 0) <= 256 * 1024;

    let diff: { line: number; left: string | null; right: string | null }[] | null = null;
    if (readable(a) && readable(b)) {
      const fa = safeArtifactPath(a.path);
      const fb = safeArtifactPath(b.path);
      const ta = fa ? await fs.readFile(fa, "utf8").catch(() => null) : null;
      const tb = fb ? await fs.readFile(fb, "utf8").catch(() => null) : null;
      if (ta !== null && tb !== null) {
        // A line-by-line comparison, not a minimal edit script. What review
        // needs is "what is different", and the cheap version of that never
        // lies about lines that did not change.
        const la = ta.split("\n");
        const lb = tb.split("\n");
        diff = [];
        for (let i = 0; i < Math.max(la.length, lb.length); i += 1) {
          if (la[i] !== lb[i]) {
            diff.push({ line: i + 1, left: la[i] ?? null, right: lb[i] ?? null });
          }
        }
      }
    }

    return {
      older: a,
      newer: b,
      identical: Boolean(a.sha256 && a.sha256 === b.sha256),
      diff,
      // Facts, for the types that cannot be diffed as text. A screenshot that
      // grew by 40KB is a real observation; pretending to diff its bytes is not.
      changes: {
        bytes: [a.bytes, b.bytes],
        mime: [a.mime, b.mime],
        state: [a.state, b.state],
      },
    };
  });
}

/** Used by the runner so a transcript arrives with its provenance attached. */
export async function sha256File(full: string): Promise<string | null> {
  const buf = await fs.readFile(full).catch(() => null);
  return buf ? crypto.createHash("sha256").update(buf).digest("hex") : null;
}

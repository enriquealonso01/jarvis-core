/**
 * Tools, classified by a person at attach time (plan S31).
 *
 * The gate this step is built on is a human reading a sentence — and the
 * sentence was written by the thing being gated. That inverts the usual threat
 * model, and the plan is specific about both halves:
 *
 *   "A description reaching the model is the familiar injection. A description
 *    reaching the CLASSIFIER is worse, because the gate this step is built on
 *    is a human reading a sentence the server wrote. A destructive tool
 *    described as 'safe, read-only diagnostics' gets classified Level 1 by an
 *    honest reviewer doing exactly what the plan asks."
 *
 * So the rule that matters most here is not about storage or hashing. It is
 * that **nothing in this module ever derives a level from a description**. The
 * default is Level 3 whatever the description says, and a description claiming
 * safety produces exactly the same default as one describing a catastrophe.
 * That is asserted directly, because it is the sort of helpfulness that gets
 * added later by someone trying to save the reviewer a click.
 *
 * The description is still kept and still shown — a classifier needs to read
 * it — but it is handed over quoted and labelled, as evidence about a claim
 * rather than as a statement of what the tool does.
 */
import crypto from "node:crypto";
import type pg from "pg";

export type ToolManifestEntry = {
  name: string;
  description?: string | null;
  inputSchema?: Record<string, unknown> | null;
};

export type ToolRow = {
  name: string;
  description: string | null;
  /** What a person said it lets Jarvis do. Null until classified. */
  capability: string | null;
  level: number | null;
  manifestHash: string;
  classifiedHash: string | null;
  /** Callable = classified, and classified against the manifest it still has. */
  callable: boolean;
  /** Why not, when it is not. Empty when it is. */
  reason: string;
};

/**
 * The identity of a tool as the caller would experience it.
 *
 * Names, descriptions and schemas together, because any one of them changing
 * changes what the tool does or what a reviewer would have decided about it.
 * The server's own version string is deliberately NOT an input: it is authored
 * by the same party as the tool, and a server that rewrites a description
 * without touching it is the case this exists to catch.
 *
 * Canonical JSON with sorted keys, so a schema that serialises in a different
 * key order is not mistaken for a different tool.
 */
export function toolHash(entry: ToolManifestEntry): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, canonical(val)]),
      );
    }
    return v;
  };
  const payload = JSON.stringify(canonical({
    name: entry.name,
    description: entry.description ?? "",
    inputSchema: entry.inputSchema ?? {},
  }));
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/**
 * Record what a server says it offers.
 *
 * Levels are never touched here. A tool whose manifest changed keeps its old
 * level and its old `classified_hash`, and becomes uncallable because the two
 * hashes no longer agree — staleness is derived from the mismatch rather than
 * maintained by remembering to clear something. A tool that has DISAPPEARED
 * from the manifest is left in place rather than deleted: it is not callable
 * (nothing will invoke a name the server no longer offers) and the row is the
 * record that it was once classified, which is worth more than a tidy table.
 */
export async function syncTools(
  pool: pg.Pool,
  connectionId: string,
  manifest: ToolManifestEntry[],
): Promise<{ added: number; changed: number; unchanged: number }> {
  let added = 0;
  let changed = 0;
  let unchanged = 0;

  for (const entry of manifest) {
    const hash = toolHash(entry);
    const existing = await pool.query<{ manifest_hash: string }>(
      `SELECT manifest_hash FROM connection_tools WHERE connection_id = $1 AND name = $2`,
      [connectionId, entry.name],
    );
    if (!existing.rows[0]) {
      await pool.query(
        `INSERT INTO connection_tools (connection_id, name, description, input_schema, manifest_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [connectionId, entry.name, entry.description ?? null,
          JSON.stringify(entry.inputSchema ?? {}), hash],
      );
      added += 1;
      continue;
    }
    if (existing.rows[0].manifest_hash === hash) {
      unchanged += 1;
      continue;
    }
    await pool.query(
      `UPDATE connection_tools
          SET description = $3, input_schema = $4, manifest_hash = $5
        WHERE connection_id = $1 AND name = $2`,
      [connectionId, entry.name, entry.description ?? null,
        JSON.stringify(entry.inputSchema ?? {}), hash],
    );
    changed += 1;
  }
  return { added, changed, unchanged };
}

/**
 * A person's decision, pinned to the manifest it was made against.
 *
 * `by` is recorded because "classified at attach time, by a person, once" is
 * only checkable if the row says who. There is no path here that classifies
 * anything automatically.
 */
export async function classifyTool(
  pool: pg.Pool,
  args: {
    connectionId: string; name: string; level: 1 | 2 | 3; by: string;
    /**
     * What this actually lets Jarvis do, in the classifier's own words.
     *
     * Required, because the Connections tab is specified to show a capability
     * rather than a tool name and there is nowhere else for one to come from.
     * Not defaulted from the name (which is what the tab must stop showing) and
     * not from the description (written by the thing being gated) - either
     * would be the server describing its own blast radius.
     */
    capability: string;
  },
): Promise<boolean> {
  const capability = args.capability.trim();
  if (!capability) throw new Error("a classification has to say what the tool lets Jarvis do");
  const r = await pool.query(
    `UPDATE connection_tools
        SET level = $3, classified_by = $4, classified_at = now(),
            classified_hash = manifest_hash, capability = $5
      WHERE connection_id = $1 AND name = $2`,
    [args.connectionId, args.name, args.level, args.by, capability],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * The level a tool gets when nobody has said otherwise.
 *
 * It takes no arguments on purpose. The plan's honest default for an arbitrary
 * server — where the description is the only evidence — is Level 3, and the way
 * that default gets quietly undermined is by someone passing the description in
 * here to "help": an unverifiable claim of safety is not evidence of safety,
 * and one confirmation click is a cheaper mistake than the alternative.
 */
export function defaultLevel(): 3 {
  return 3;
}

/**
 * The description, handed over as what it is.
 *
 * Returned as a labelled, quoted object rather than a bare string, so it cannot
 * be dropped into a prompt or a UI line as though Jarvis had written it. The
 * caller has to reach past `claim` to get the text, and at that point it is
 * obvious what it is.
 */
export function describeForClassifier(tool: { name: string; description: string | null }): {
  name: string;
  untrusted: true;
  claim: string;
  note: string;
} {
  return {
    name: tool.name,
    untrusted: true,
    claim: tool.description ?? "",
    note: "Written by the server's author. A claim about what this tool does, not a specification of it.",
  };
}

export async function toolsFor(pool: pg.Pool, connectionId: string): Promise<ToolRow[]> {
  const r = await pool.query<{
    name: string; description: string | null; level: number | null;
    manifest_hash: string; classified_hash: string | null; capability: string | null;
  }>(
    `SELECT name, description, level, manifest_hash, classified_hash, capability
       FROM connection_tools WHERE connection_id = $1 ORDER BY name`,
    [connectionId],
  );
  return r.rows.map((t) => {
    const stale = t.classified_hash !== null && t.classified_hash !== t.manifest_hash;
    const callable = t.level !== null && !stale;
    return {
      name: t.name,
      description: t.description,
      capability: t.capability,
      level: t.level,
      manifestHash: t.manifest_hash,
      classifiedHash: t.classified_hash,
      callable,
      reason: callable
        ? ""
        : stale
          ? "the tool changed since it was classified, so it is inert until reclassified"
          : "the tool has not been classified, so it is attached and inert",
    };
  });
}

export async function toolStatus(
  pool: pg.Pool,
  connectionId: string,
  name: string,
): Promise<ToolRow | null> {
  return (await toolsFor(pool, connectionId)).find((t) => t.name === name) ?? null;
}

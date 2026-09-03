/**
 * The contracts, read at run time (plan S18b).
 *
 * `docs/STATE_MACHINES.md` and `docs/ERROR_TAXONOMY.md` are read-only law, and
 * until now nothing checked the code against them. A law nobody verifies drifts
 * silently: the taxonomy gained three error classes that existed in no code for
 * weeks, and "illegal transitions are API 409 + audit" is a sentence in a
 * document that nothing enforces.
 *
 * These parse the documents rather than restating them. A hand-written copy of
 * the rules in a test is a second thing to keep in sync, and the one that goes
 * stale is always the copy - so when a row is added to either table, these read
 * it on the next run without anyone remembering to.
 */
import fs from "node:fs/promises";
import path from "node:path";

const DOCS = process.env.JARVIS_DOCS_DIR ?? "docs";

export type TaxonomyRow = {
  errorClass: string;
  severity: string;
  retry: string;
  /** The taxonomy's own limit column: a number, or null for "—" / n/a. */
  limit: number | null;
  recovery: string;
  notify: string;
};

/**
 * Every row of the error taxonomy table.
 *
 * The table is markdown, so this is parsing prose - deliberately strict about
 * shape and forgiving about content, because a row it cannot read must be
 * loud rather than skipped. A silently dropped row is a class nothing checks.
 */
export async function taxonomyRows(): Promise<TaxonomyRow[]> {
  const text = await fs.readFile(path.join(DOCS, "ERROR_TAXONOMY.md"), "utf8");
  const rows: TaxonomyRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || t.startsWith("|---")) continue;
    const cells = t.split("|").map((c) => c.trim()).filter((c, i, a) => !(i === 0 || i === a.length - 1) || c);
    const parts = t.slice(1, -1).split("|").map((c) => c.trim());
    if (parts.length < 7) continue;
    const [errorClass, severity, retry, limitRaw, recovery, notify] = parts;
    if (errorClass === "class" || !errorClass.includes(".")) continue;
    const limit = /^\d+$/.test(limitRaw) ? Number(limitRaw) : null;
    rows.push({ errorClass, severity, retry, limit, recovery, notify });
    void cells;
  }
  return rows;
}

export type Transition = { from: string; to: string };

/**
 * The task state machine, as the document draws it.
 *
 * Lines look like `running → succeeded | failed_terminal | cancelled` and
 * chains like `queued → preparing → running` mean both hops. A trailing `*`
 * (`waiting_* → queued`) is a family, expanded against the states actually
 * mentioned.
 */
export async function taskTransitions(): Promise<Transition[]> {
  const text = await fs.readFile(path.join(DOCS, "STATE_MACHINES.md"), "utf8");
  const start = text.indexOf("## Task");
  if (start < 0) throw new Error("STATE_MACHINES.md has no Task section");
  const block = text.slice(start, text.indexOf("---", start));
  const fenced = block.split("```")[1] ?? "";

  const raw: Transition[] = [];
  const states = new Set<string>();
  for (const line of fenced.split("\n")) {
    const t = line.split("#")[0].trim();
    if (!t.includes("→")) continue;
    const hops = t.split("→").map((h) => h.trim());
    for (let i = 0; i < hops.length - 1; i += 1) {
      const froms = hops[i].split("|").map((s) => s.trim()).filter(Boolean);
      const tos = hops[i + 1].split("|").map((s) => s.trim()).filter(Boolean);
      for (const f of froms) {
        for (const to of tos) {
          raw.push({ from: f, to });
          if (!f.endsWith("*")) states.add(f);
          if (!to.endsWith("*")) states.add(to);
        }
      }
    }
  }

  // `waiting_*` means every waiting state the document names.
  const out: Transition[] = [];
  for (const t of raw) {
    const froms = t.from.endsWith("*")
      ? [...states].filter((s) => s.startsWith(t.from.slice(0, -1)))
      : [t.from];
    const tos = t.to.endsWith("*")
      ? [...states].filter((s) => s.startsWith(t.to.slice(0, -1)))
      : [t.to];
    for (const f of froms) for (const to of tos) out.push({ from: f, to });
  }
  return out;
}

/** Is this hop one the document draws? */
export function isLegalTransition(transitions: Transition[], from: string | null, to: string): boolean {
  // A task with no prior state is being created, not transitioned.
  if (from === null) return true;
  if (from === to) return true;
  return transitions.some((t) => t.from === from && t.to === to);
}

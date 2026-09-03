/**
 * The data Home's map is drawn from (plan S51).
 *
 * S51 rebuilds Home as "a single no-scroll view of the whole system": a
 * node-link map where the Supervisor is the hub, projects sit around it, and
 * memory, running work and needs-you are their own points. The drawing is
 * console work. What lives here is the only part that can make the drawing
 * honest — the nodes themselves.
 *
 * THE LINE THIS STEP MUST NOT CROSS, in the plan's own words:
 *
 *   "A map of real objects is an operations console; a map that **moves, glows,
 *    or fills space for atmosphere** is the 'movie prop / decorative dashboard /
 *    fake holographic interface' I.3 forbids... **a node is a real object, an
 *    edge is a real relationship, position and size carry meaning, and motion
 *    happens only when real state changes. If a point cannot be tied to a field,
 *    it does not belong on Home.**"
 *
 * So every node here is built from a row, carries the `source` it came from, and
 * carries an `href` into a page that already exists. A node whose source could
 * not be resolved renders `unknown` — the plan is explicit: "**a node whose
 * source is unknown renders `unknown`, never a fabricated point**".
 *
 * AND MOTION HAS NO CLOCK. `motionFor` takes a node's state and nothing else,
 * which is the same shape S49's orb uses and for the same reason: "assert that
 * motion is driven by real events, not a timer". A pulse for atmosphere is not
 * discouraged here, it is unwritable, because there is no time in scope to drive
 * one.
 *
 * MEMORY IS A SHAPE, NOT A CORPUS. "Home shows that the corpus exists and is the
 * way in, **not** 279k chunks rendered as points... Drawing the whole graph is
 * noise, and noise on Home is the thing being removed." So the memory node is one
 * node carrying a count, and the suite asserts the node count does not grow with
 * the corpus.
 */
import type pg from "pg";
import { PORTFOLIO_ONLY } from "./systemscope.js";

/** The S15 states a node may be in. `unknown` is the honest one. */
export const NODE_STATES = [
  "ok", "active", "needs_you", "empty", "stale", "offline", "unknown",
] as const;
export type NodeState = (typeof NODE_STATES)[number];

export type HomeNode = {
  id: string;
  kind: "supervisor" | "project" | "memory" | "running" | "needs_you" | "build";
  /** Always present. "Never colour alone." */
  label: string;
  state: NodeState;
  /** Where clicking goes. A node that leads nowhere does not belong on Home. */
  href: string;
  /** Which table this came from, so a point can be tied to a field. */
  source: string;
  /** Size carries meaning: how many things this point stands for. */
  weight: number;
};

export type HomeEdge = { from: string; to: string; rel: string };

export type HomeMap = {
  nodes: HomeNode[];
  edges: HomeEdge[];
  /** Overall, for the empty-state rule: calm is not broken. */
  state: "calm" | "busy" | "needs_you" | "offline";
};

const SUPERVISOR = "supervisor";

/**
 * Everything Home draws, from rows.
 *
 * Nodes that would be empty are OMITTED rather than drawn grey: "running work and
 * needs-you as nodes that appear only when non-empty and light up when they do;
 * when both are empty the map reads calm". A permanently present node showing
 * zero is a point that carries no information and still costs space on a screen
 * whose whole purpose is fitting.
 */
export async function homeMap(pool: pg.Pool): Promise<HomeMap> {
  const nodes: HomeNode[] = [{
    id: SUPERVISOR,
    kind: "supervisor",
    label: "Jarvis",
    state: "ok",
    href: "/",
    source: "supervisor",
    weight: 1,
  }];
  const edges: HomeEdge[] = [];

  /*
   * S45's scope fragment, so Home shows his projects and not the housekeeping.
   * Reused rather than re-written: two places deciding what a project is drift,
   * and the one that drifts is always the one nobody is looking at.
   */
  const projects = await pool.query<{ id: string; slug: string; name: string; running: number }>(
    `SELECT p.id, p.slug, p.name,
            (SELECT count(*) FROM tasks t
              WHERE t.project_id = p.id
                AND t.state IN ('running','preparing','recovering'))::int AS running
       FROM projects p
      WHERE p.archived_at IS NULL AND ${PORTFOLIO_ONLY}
      ORDER BY p.name`,
  );
  for (const p of projects.rows) {
    nodes.push({
      id: `project:${p.id}`,
      kind: "project",
      label: p.name,
      /*
       * "A project carrying live work marked as such - and it is marked BECAUSE a
       * task is running, not on a timer." The mark is a count from the tasks
       * table, so it cannot be true while nothing is happening.
       */
      state: p.running > 0 ? "active" : "ok",
      href: `/projects/${p.slug}`,
      source: "projects",
      weight: Math.max(1, p.running),
    });
    edges.push({ from: SUPERVISOR, to: `project:${p.id}`, rel: "project" });
  }

  /*
   * ONE node for memory, carrying a count. Not 279k points: "Home shows that the
   * corpus exists and is the way in", and the exploring happens in S18/S30.
   */
  const memory = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM knowledge_chunks`,
  );
  const chunks = Number(memory.rows[0]?.n ?? 0);
  nodes.push({
    id: "memory",
    kind: "memory",
    label: chunks ? `Memory · ${chunks.toLocaleString()} pieces` : "Memory",
    state: chunks ? "ok" : "empty",
    href: "/search",
    source: "knowledge_chunks",
    weight: 1,
  });
  edges.push({ from: SUPERVISOR, to: "memory", rel: "remembers" });

  const running = await pool.query<{ n: string; id: string | null }>(
    `SELECT count(*) AS n, min(id::text) AS id FROM tasks
      WHERE state IN ('running','preparing','recovering')`,
  );
  const runningCount = Number(running.rows[0]?.n ?? 0);
  if (runningCount > 0) {
    nodes.push({
      id: "running",
      kind: "running",
      label: `Running · ${runningCount}`,
      state: "active",
      href: runningCount === 1 && running.rows[0].id ? `/work/${running.rows[0].id}` : "/work",
      source: "tasks",
      weight: runningCount,
    });
    edges.push({ from: SUPERVISOR, to: "running", rel: "running" });
  }

  const needs = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM issues
      WHERE status NOT IN ('resolved','ignored') AND owner = 'user'`,
  );
  const needsCount = Number(needs.rows[0]?.n ?? 0);
  if (needsCount > 0) {
    nodes.push({
      id: "needs_you",
      kind: "needs_you",
      label: `Needs you · ${needsCount}`,
      state: "needs_you",
      href: "/issues",
      source: "issues",
      weight: needsCount,
    });
    edges.push({ from: SUPERVISOR, to: "needs_you", rel: "needs_you" });
  }

  return {
    nodes,
    edges,
    /*
     * "When both are empty the map reads CALM, per S13's empty-state rule - not
     * broken." So calm is a state the map reports, rather than an absence the
     * console has to interpret.
     */
    state: needsCount > 0 ? "needs_you" : runningCount > 0 ? "busy" : "calm",
  };
}

/**
 * A node whose source could not be resolved.
 *
 * "A node whose source is unknown renders `unknown`, **never a fabricated
 * point**." Offered as a constructor so the honest thing is the easy thing: the
 * alternative — inventing a plausible label and a plausible href — is what
 * happens when there is nothing else to return.
 */
export function unknownNode(id: string, source: string): HomeNode {
  return {
    id,
    kind: "project",
    label: "Unknown",
    state: "unknown",
    href: "",
    source,
    weight: 1,
  };
}

/**
 * How much this node moves.
 *
 * Takes a state. There is no clock, no elapsed time and no frame counter here,
 * so "the map does not animate for atmosphere" is a property of what this
 * function can see rather than a note asking the next person not to add a pulse.
 * Motion appears when the STATE says something is happening, and stops when it
 * stops.
 */
export function motionFor(state: NodeState): number {
  if (state === "active") return 1;
  if (state === "needs_you") return 1;
  return 0;
}

/**
 * Is Home legible without scrolling?
 *
 * The plan's headline test is "the whole system is legible WITHOUT SCROLLING" on
 * desktop and on a 375px phone. What the console can draw is its business; what
 * this can answer is whether the map has been handed more points than a screen
 * can hold — which is the thing that makes scrolling necessary, and the thing a
 * later change would cause without meaning to.
 */
export const MAX_NODES_SMALL = 18;
export const MAX_NODES_DESKTOP = 40;

export function fitsWithoutScrolling(
  map: HomeMap,
  viewport: "small" | "desktop",
): { fits: boolean; overflow: number; why: string } {
  const cap = viewport === "small" ? MAX_NODES_SMALL : MAX_NODES_DESKTOP;
  const overflow = Math.max(0, map.nodes.length - cap);
  return {
    fits: overflow === 0,
    overflow,
    why: overflow === 0
      ? `${map.nodes.length} points fit a ${viewport} screen`
      : `${map.nodes.length} points is ${overflow} more than a ${viewport} screen holds — `
        + "the list equivalent is the right answer here, not smaller type",
  };
}

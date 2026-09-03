/**
 * S51 — Home's map, checked against the LIVE database.
 *
 * Not a fixture. The plan's rule is "if a point cannot be tied to a field, it
 * does not belong on Home", and the only way to test that claim is to draw the
 * map from real rows and check every point back against the table it names.
 *
 * Run on the box:
 *   docker compose exec -u node api node --import tsx scripts/s51-homemap-live.ts
 */
import { createPool } from "../src/db.js";
import {
  fitsWithoutScrolling, homeMap, motionFor, unknownNode, shouldDraw,
  MAX_NODES_DESKTOP, MAX_NODES_SMALL, NODE_STATES,
} from "../src/homemap.js";
import { PORTFOLIO_ONLY } from "../src/systemscope.js";

async function main() {
  /*
   * The app's own pool factory rather than a connection string assembled here.
   * db.ts already knows that the password arrives as POSTGRES_PASSWORD and has
   * to be URL-encoded - a probe that rebuilds that gets it wrong once and then
   * reports the product broken.
   */
  const pool = createPool();
  let pass = 0, fail = 0;
  const ok = (n: string, c: boolean, d = "") => {
    if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); }
  };

  const map = await homeMap(pool);
  console.log(`state: ${map.state}   nodes: ${map.nodes.length}   edges: ${map.edges.length}`);
  for (const n of map.nodes) {
    console.log(`  ${n.kind.padEnd(11)} ${String(n.state).padEnd(9)} w=${String(n.weight).padEnd(4)}`
      + `${n.href.padEnd(26)} src=${n.source.padEnd(17)} ${n.label}`);
  }

  console.log("\n== every point ties to a field ==");
  for (const n of map.nodes) {
    ok(`${n.id}: label, href and source all present`,
      !!n.label && !!n.href && !!n.source, JSON.stringify(n));
    ok(`${n.id}: ${n.state} is a real state`,
      (NODE_STATES as readonly string[]).includes(n.state), n.state);
    ok(`${n.id}: weight ${n.weight} carries meaning`,
      Number.isInteger(n.weight) && n.weight >= 1, String(n.weight));
  }

  console.log("\n== every edge joins two nodes that exist ==");
  const ids = new Set(map.nodes.map((n) => n.id));
  for (const e of map.edges) {
    ok(`${e.from} -> ${e.to} (${e.rel})`, ids.has(e.from) && ids.has(e.to));
  }
  ok("every non-supervisor node is reachable from the hub",
    map.nodes.filter((n) => n.kind !== "supervisor")
      .every((n) => map.edges.some((e) => e.to === n.id)));

  console.log("\n== the counts are the database's, not the map's ==");
  const q = async (sql: string) => (await pool.query<{ n: number }>(sql)).rows[0].n;
  const running = await q(
    "SELECT count(*)::int n FROM tasks WHERE state IN ('running','preparing','recovering')");
  const needs = await q(
    "SELECT count(*)::int n FROM issues WHERE status NOT IN ('resolved','ignored') AND owner = 'user'");
  const chunks = await q("SELECT count(*)::int n FROM knowledge_chunks");
  const projects = await q(
    `SELECT count(*)::int n FROM projects p WHERE p.archived_at IS NULL AND ${PORTFOLIO_ONLY}`);
  console.log(`  db: running=${running} needs_you=${needs} chunks=${chunks} portfolio_projects=${projects}`);

  ok("a running node appears exactly when there is running work",
    map.nodes.some((n) => n.kind === "running") === shouldDraw(running));
  ok("a needs-you node appears exactly when something needs him",
    map.nodes.some((n) => n.kind === "needs_you") === shouldDraw(needs));
  ok("the map's overall state agrees with the rows",
    map.state === (needs > 0 ? "needs_you" : running > 0 ? "busy" : "calm"), map.state);
  ok("one project node per portfolio project",
    map.nodes.filter((n) => n.kind === "project").length === projects);
  ok(`${chunks} chunks render as exactly one memory node`,
    map.nodes.filter((n) => n.kind === "memory").length === 1);
  const mem = map.nodes.find((n) => n.kind === "memory")!;
  ok("and the memory node says so rather than implying it",
    chunks > 0 ? mem.state === "ok" && mem.label.includes("pieces") : mem.state === "empty");
  console.log("");
  console.log("== does it fit on one screen ==");
  /*
   * Asserting `nodes.length <= MAX_NODES_SMALL` would assert a promise the module
   * does not make. `fitsWithoutScrolling` REPORTS; the console decides what to
   * draw. So what is checked is that it reports the truth about the live map -
   * and the live number is printed either way, because the number is the finding.
   */
  for (const [viewport, cap] of [["small", MAX_NODES_SMALL], ["desktop", MAX_NODES_DESKTOP]] as const) {
    const f = fitsWithoutScrolling(map, viewport);
    console.log(`  ${viewport}: ${map.nodes.length} points, cap ${cap} -> `
      + (f.fits ? "fits" : `overflows by ${f.overflow}`));
    ok(`${viewport}: the verdict matches the count`,
      f.fits === (map.nodes.length <= cap) && f.overflow === Math.max(0, map.nodes.length - cap), f.why);
    ok(`${viewport}: an overflow says what to do instead`,
      f.fits || /list equivalent/.test(f.why), f.why);
  }

  console.log("\n== motion has no clock ==");
  ok("motionFor takes a state and nothing else", motionFor.length === 1);
  ok("the same state gives the same motion", motionFor("ok") === motionFor("ok"));
  ok("a node whose source is unknown says unknown",
    unknownNode("x", "nowhere").state === "unknown");
  ok("and it still has a label, because colour is never alone",
    !!unknownNode("x", "nowhere").label);

  console.log(`==== ${pass} passed, ${fail} failed ====`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main();

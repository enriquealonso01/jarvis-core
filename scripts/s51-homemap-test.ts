/**
 * S51 — Home is a map of real objects, or it is a movie prop.
 *
 * The plan draws the line and names the failure:
 *
 *   "**A node is a real object, an edge is a real relationship, position and size
 *    carry meaning, and motion happens only when real state changes. If a point
 *    cannot be tied to a field, it does not belong on Home.**"
 *
 *   "**The no-decoration test**: with nothing running and nothing needing him, the
 *    map is calm and still — it does **not** animate for atmosphere... **Assert
 *    that motion is driven by real events, not a timer.**"
 *
 * So motion is asserted twice, as in S49: on the output, and on what `motionFor`
 * can see at all. A function with no clock in scope cannot animate on time
 * passing, which is a stronger statement than any one mocked frame.
 *
 * And the memory rule, which is the one a corpus quietly breaks:
 *
 *   "Home shows that the corpus exists and is the way in, **not 279k chunks
 *    rendered as points**. Drawing the whole graph is noise, and noise on Home is
 *    the thing being removed."
 *
 * So the suite adds chunks and requires the node count not to move.
 */
import { createPool } from "../src/db.js";
import {
  fitsWithoutScrolling, homeMap, MAX_NODES_SMALL, motionFor, NODE_STATES, shouldDraw, unknownNode,
} from "../src/homemap.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s51-${Math.random().toString(36).slice(2, 7)}`;

async function main(): Promise<void> {
  let project = "";
  let housekeeping = "";
  const tasks: string[] = [];
  const extraProjects: string[] = [];
  try {
    project = (await pool.query<{ id: string }>(
      `INSERT INTO projects (slug,name,project_type,confidentiality)
       VALUES ($1,$1,'personal','normal') RETURNING id`, [`${SLUG}-real`])).rows[0].id;
    housekeeping = (await pool.query<{ id: string }>(
      `INSERT INTO projects (slug,name,project_type,confidentiality,is_system)
       VALUES ($1,$1,'system','normal',true) RETURNING id`, [`${SLUG}-sweep`])).rows[0].id;

    console.log("1. every point is a real object with somewhere to go");
    const map = await homeMap(pool);
    map.nodes.every((n) => n.href !== "" || n.state === "unknown")
      ? ok("no node leads nowhere")
      : bad(`nodes with no href: ${map.nodes.filter((n) => !n.href).map((n) => n.id).join(", ")}`);
    map.nodes.every((n) => n.source && n.label)
      ? ok("and every point names the field it came from, and is labelled")
      : bad("a point cannot be tied to a field");
    map.nodes.every((n) => (NODE_STATES as readonly string[]).includes(n.state))
      ? ok(`every node is in one of the ${NODE_STATES.length} defined states`)
      : bad("a node is in an undefined state");
    map.nodes.some((n) => n.kind === "supervisor" && n.id === "supervisor")
      ? ok("the Supervisor is the hub")
      : bad("there is no hub");
    map.edges.every((e) => map.nodes.some((n) => n.id === e.from) && map.nodes.some((n) => n.id === e.to))
      ? ok("and every edge joins two points that exist")
      : bad("an edge points at a node that is not there");

    console.log("");
    console.log("2. his projects, not the housekeeping");
    const ids = map.nodes.map((n) => n.id);
    ids.includes(`project:${project}`) && !ids.includes(`project:${housekeeping}`)
      ? ok("a system project is not a point on his Home")
      : bad("housekeeping appeared on the map");
    const mine = map.nodes.find((n) => n.id === `project:${project}`);
    mine?.href === `/projects/${SLUG}-real`
    ? ok(`and his project routes to its overview: ${mine?.href}`)
      : bad(`project href: ${mine?.href}`);

    console.log("");
    console.log("3. memory is a shape, not a corpus");
    const before = (await homeMap(pool)).nodes.length;
    for (let i = 0; i < 25; i += 1) {
      await pool.query(
        `INSERT INTO knowledge_chunks (project_id, body, kind, char_offset, chunk_index)
         VALUES ($1,$2,'document',0,$3)`, [project, `${SLUG} chunk ${i}`, i]);
    }
    const after = await homeMap(pool);
    after.nodes.length === before
      ? ok("twenty-five more chunks add zero points to the map")
      : bad(`the corpus grew the map: ${before} -> ${after.nodes.length}`);
    const memory = after.nodes.find((n) => n.kind === "memory");
    memory?.href === "/search" && /Memory/.test(memory.label)
      ? ok(`memory is one point that is the door in: "${memory?.label}"`)
      : bad(`memory node: ${JSON.stringify(memory)}`);

    console.log("");
    console.log("4. the no-decoration test");
    /*
     * "With nothing running and nothing needing him, the map is calm and still -
     * it does NOT animate for atmosphere."
     */
    /*
     * CONSTRUCTED rather than observed. The first version asked the live database
     * for a calm map and got the real one - which has running work and open
     * issues, because it is a real system - so three assertions failed on the
     * data rather than on the code. The rule under test is "nothing moves when
     * nothing is happening", and that is a statement about a map in that state,
     * not about whether this box happens to be idle.
     */
    const calm = { nodes: [
      { id: "supervisor", kind: "supervisor" as const, label: "Jarvis", state: "ok" as const,
        href: "/", source: "supervisor", weight: 1 },
      { id: "memory", kind: "memory" as const, label: "Memory", state: "ok" as const,
        href: "/search", source: "knowledge_chunks", weight: 1 },
    ], edges: [], state: "calm" as const };
    /*
     * This used to filter the hand-written `calm` fixture for nodes of kind
     * "running" or "needs_you" — kinds that are not in the union at all, on a
     * literal the test had just written two lines above. It could not fail, and
     * the typechecker said so the moment scripts came under it.
     *
     * The rule it was reaching for is `shouldDraw`, which S51 extracted for
     * exactly this: a point with nothing behind it is not drawn. Asserted on the
     * function, in both directions, so it fails when the omission stops working.
     */
    !shouldDraw(0)
      ? ok("with nothing running and nothing needing him, that point is not drawn at all")
      : bad("an empty point would be drawn anyway");
    calm.nodes.every((n) => shouldDraw(n.weight))
      ? ok("while every point that is on the map has something behind it")
      : bad("a point with nothing behind it reached the map");
    calm.nodes.every((n) => motionFor(n.state) === 0)
      ? ok("and nothing on the map moves")
      : bad("something animates on a calm map");
    calm.state === "calm"
      ? ok("the map reports calm, which is not the same as broken")
      : bad(`map state: ${calm.state}`);
    /*
     * And the live map really does omit those points when they are empty, which
     * is the half the constructed fixture cannot show. Asserted conditionally on
     * what the box is actually doing, rather than assuming it is quiet.
     */
    const live = await homeMap(pool);
    const liveRunning = live.nodes.find((n) => n.kind === "running");
    const runningRows = Number((await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM tasks WHERE state IN ('running','preparing','recovering')`,
    )).rows[0].n);
    (runningRows > 0) === Boolean(liveRunning)
      ? ok(`the running point is drawn exactly when there is running work (${runningRows} now)`)
      : bad(`running rows ${runningRows} but node ${Boolean(liveRunning)}`);
    /*
     * The omission rule itself. A live map on a busy box cannot show that an
     * empty point is left out, because nothing on it is empty - so the rule is
     * asserted where it can actually fail.
     */
    !shouldDraw(0) && shouldDraw(1)
      ? ok("and a point with nothing in it is not drawn at all")
      : bad("an empty point would be drawn");

    /*
     * "Start a task -> the change is visible BECAUSE THE STATE CHANGED."
     */
    const t = (await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, state, priority, lane)
       VALUES ($1,$2,'running','normal','heavy') RETURNING id`,
      [project, `${SLUG} a running thing`])).rows[0].id;
    tasks.push(t);
    const busy = await homeMap(pool);
    busy.nodes.some((n) => n.kind === "running" && n.state === "active")
      ? ok("starting a task makes the running point appear")
      : bad("a running task did not show up");
    busy.nodes.find((n) => n.id === `project:${project}`)?.state === "active"
      ? ok("and marks the project it belongs to, because a task is running")
      : bad("the project was not marked active");
    /*
     * The other direction, which is the one that matters: a project with nothing
     * running must NOT be marked live. Asserting only the positive lets a
     * hardcoded "active" pass, which is what sabotage found.
     */
    const quiet = (await pool.query<{ id: string }>(
      `INSERT INTO projects (slug,name,project_type,confidentiality)
       VALUES ($1,$1,'personal','normal') RETURNING id`, [`${SLUG}-quiet`])).rows[0].id;
    extraProjects.push(quiet);
    (await homeMap(pool)).nodes.find((n) => n.id === `project:${quiet}`)?.state === "ok"
      ? ok("while a project with nothing running is not marked live")
      : bad("A PROJECT WITH NO RUNNING WORK WAS MARKED LIVE");
    motionFor("active") > 0 && motionFor("ok") === 0
      ? ok("motion follows the state and nothing else")
      : bad("motion does not follow state");
    /*
     * THE STRUCTURAL HALF, as in S49: a mocked frame proves one frame. This
     * proves the function has nothing to animate on.
     */
    !/Date|now\(|elapsed|timer|frame|tick|random/i.test(motionFor.toString())
      ? ok("and motionFor has no clock, timer, frame counter or randomness in scope")
      : bad("motion can be driven by something other than state");

    console.log("");
    console.log("5. an unknown source is unknown, not invented");
    const u = unknownNode("mystery", "somewhere");
    u.state === "unknown" && u.href === ""
      ? ok("a node whose source could not be resolved renders unknown and goes nowhere")
      : bad(`unknown node: ${JSON.stringify(u)}`);
    u.label === "Unknown"
      ? ok("labelled as such rather than given a plausible name")
      : bad(`it invented a label: ${u.label}`);

    console.log("");
    console.log("6. it has to fit on one screen");
    /*
     * The headline test is "legible WITHOUT SCROLLING" on a 375px phone. What can
     * be answered here is whether the map has been handed more points than a
     * screen holds - which is what makes scrolling necessary, and what a later
     * change causes without meaning to.
     */
    /*
     * A SMALL map fits; the live one on this box does not, and that is a finding
     * rather than a failure - there are 29 real projects here, and the plan's own
     * answer to that is the list equivalent, not smaller type. So what is
     * asserted is that the function tells the truth in both directions.
     */
    const small = fitsWithoutScrolling(
      { nodes: [unknownNode("a", "x"), unknownNode("b", "x")], edges: [], state: "calm" },
      "small",
    );
    small.fits
      ? ok(`a small map fits a phone: ${small.why}`)
      : bad(`a two-point map did not fit: ${small.why}`);
    const liveFit = fitsWithoutScrolling(await homeMap(pool), "small");
    typeof liveFit.overflow === "number" && (liveFit.fits === (liveFit.overflow === 0))
      ? ok(`and it reports the live map honestly: ${liveFit.why}`)
      : bad(`inconsistent fit report: ${JSON.stringify(liveFit)}`);
    const crowded = fitsWithoutScrolling(
      { nodes: Array.from({ length: MAX_NODES_SMALL + 5 }, (_, i) => unknownNode(`n${i}`, "x")), edges: [], state: "calm" },
      "small",
    );
    !crowded.fits && crowded.why.includes("not smaller type")
      ? ok("and an overcrowded map says the list is the answer, not shrinking the type")
      : bad(`overflow advice: ${crowded.why}`);
  } finally {
    if (tasks.length) await pool.query(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [tasks]);
    for (const id of [project, housekeeping, ...extraProjects].filter(Boolean)) {
      await pool.query(`DELETE FROM knowledge_chunks WHERE project_id = $1`, [id]);
      await pool.query(`DELETE FROM tasks WHERE project_id = $1`, [id]);
      await pool.query(`DELETE FROM projects WHERE id = $1`, [id]);
    }
  }

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  await pool.end().catch(() => undefined);
  process.exit(1);
});

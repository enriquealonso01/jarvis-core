/**
 * S30 — which tier answers, and why that is an evidence question.
 *
 * The plan's rule is not about topic. It is about what can be cited most
 * precisely: a decision has a date and an actor, a document can be quoted, and
 * memory records only what Jarvis was TOLD - the weakest of the three, and the
 * only one nobody can check.
 *
 * The failure being guarded is subtle and reads perfectly well: asked "why did
 * we set the deploy policy to manual", a system that leads with a document
 * paragraph about deploy policies answers fluently, with a citation, and never
 * mentions that there is a dated decision with somebody's name on it.
 */
import { createPool } from "../src/db.js";
import { removeFixtures } from "./lib/fixtures.js";
import { ingestDocument, retrieve, tierOrderFor } from "../src/knowledge.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s30tier-${Math.random().toString(36).slice(2, 7)}`;

const created: string[] = [];

async function main(): Promise<void> {
  console.log("1. the question shape decides the order, not the subject");
  tierOrderFor("why did we set the deploy policy to manual")[0] === "activity"
    ? ok("a why-question leads with the decision")
    : bad(`why-question led with ${tierOrderFor("why did we...")[0]}`);
  tierOrderFor("what did the client say about the refund window")[0] === "knowledge"
    ? ok("a what-did-they-say question leads with the document")
    : bad("a fact question did not lead with knowledge");
  tierOrderFor("when did we decide on fourteen days")[0] === "activity"
    ? ok("and so does a when-did-we-decide question")
    : bad("a decision question led with something else");

  const both = [tierOrderFor("why did we"), tierOrderFor("what is the refund window")];
  both.every((o) => o[o.length - 1].endsWith("memory"))
    ? ok("memory is last in both orders - it is the only tier nobody can check")
    : bad(`memory was not last: ${both.map((o) => o.join(">")).join(" | ")}`);

  console.log("");
  console.log("2. a configuration change is a decision, with a date and an actor");
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG]);
  const pid = p.rows[0].id;
  created.push(pid);

  await pool.query(
    `INSERT INTO config_versions (scope, project_id, key, value, version, actor, note, caused_by_message)
     VALUES ('project', $1, 'deploy_policy', $2, 1, 'enrique', $3, $4)`,
    [pid, JSON.stringify("manual"),
      "switched to manual after the automatic deploy shipped a broken migration",
      "stop deploying alpha automatically"]);

  // A document that also discusses deploy policy, so the tiers genuinely compete.
  const art = await pool.query<{ id: string }>(
    `INSERT INTO artifacts (project_id, path, mime, quarantine_state)
     VALUES ($1,'runbook.md','text/markdown','clean') RETURNING id`, [pid]);
  await ingestDocument(pool, {
    projectId: pid, artifactId: art.rows[0].id, kind: "prose",
    text: [
      "# Deploy policy",
      "The deploy policy describes how releases reach production.",
      ...Array.from({ length: 25 }, (_, i) => `Paragraph ${i + 1} about deploy policy and release trains.`),
    ].join("\n"),
  });

  const why = await retrieve(pool, { q: "why deploy policy manual", projectId: pid });
  why.tiers[0]?.tier === "activity"
    ? ok("asked why, the decision tier comes first")
    : bad(`asked why, the first tier was ${why.tiers[0]?.tier}`);
  const decision = why.tiers.find((t) => t.tier === "activity")?.hits ?? [];
  decision.some((h) => h.body.includes("broken migration"))
    ? ok("and the reasoning is in the answer, not just the value")
    : bad("the decision came back without its reasoning");
  decision.some((h) => h.citation.includes("enrique") && h.citation.includes("deploy_policy"))
    ? ok(`cited with a date and an actor: ${decision[0]?.citation}`)
    : bad(`citation lacked the actor or the key: ${decision[0]?.citation}`);
  decision.some((h) => h.body.includes("stop deploying alpha automatically"))
    ? ok("including the message that caused it, which is what why-questions want")
    : bad("the causing message was not carried");

  console.log("");
  console.log("3. the same corpus, asked for a fact, leads with the document");
  /*
   * A question both tiers can actually answer. The first version asked "what
   * does the deploy policy DESCRIBE", and websearch_to_tsquery ANDs its terms -
   * the config row has no "describe" in it, so it legitimately did not match,
   * and the assertion was demanding a hit that should not exist.
   */
  const what = await retrieve(pool, { q: "what is the deploy policy", projectId: pid });
  what.tiers[0]?.tier === "knowledge"
    ? ok("asked what, the document comes first")
    : bad(`asked what, the first tier was ${what.tiers[0]?.tier}`);
  what.tiers.some((t) => t.tier === "activity")
    ? ok("and the decision is still returned, just not first - nothing is hidden")
    : bad("the decision tier vanished entirely");

  await pool.query(`DELETE FROM knowledge_chunks WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM config_versions WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM artifacts WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [pid]);

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

/*
 * Cleanup in a `finally`, not at the bottom of main.
 *
 * The runs that leave litter are the ones that failed, and those are exactly
 * the runs that never reach a tidy-up written at the end of the happy path.
 */
main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    fails += 1;
  })
  .finally(async () => {
    await removeFixtures(pool, created);
    await pool.end().catch(() => undefined);
    process.exit(fails === 0 ? 0 : 1);
  });

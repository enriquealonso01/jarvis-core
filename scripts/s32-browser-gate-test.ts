/**
 * S32 — the click that must stop.
 *
 * The plan names this the test that matters most in the step:
 *
 *   "Point Mode 1 at a page with a delete button and instruct it to use one. It
 *    must stop for approval. Then approve, and confirm it proceeds and records
 *    what it clicked. This is the test that matters most in this step — a
 *    browser agent that deletes without stopping has quietly repealed IV.6."
 *
 * Plus the one beside it: "A page whose only control is ambiguous → it stops
 * rather than guessing."
 *
 * The assertions are on the DECISION and the row, not on prose, and the
 * `perform` callback is a spy: "it stopped" means the thing never ran, not that
 * something said it stopped. Those come apart the first time a gate returns a
 * refusal and performs the action anyway, which is the failure that would
 * otherwise be invisible.
 */
import { createPool } from "../src/db.js";
import { classifyInteraction, gatedInteraction, type Interaction } from "../src/browsergate.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s32-${Math.random().toString(36).slice(2, 7)}`;

async function main(): Promise<void> {
  const pid = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG])).rows[0].id;

  const stops = (i: Interaction) => classifyInteraction(i).decision === "approval_required";

  console.log("1. reading is free");
  (["navigate", "read", "screenshot"] as const).every((kind) =>
    !stops({ url: "https://example.com/x", kind }))
    ? ok("navigating, reading and screenshotting need no approval")
    : bad("a read-only action asked for approval");

  console.log("");
  console.log("2. the delete button stops");
  const del: Interaction = {
    url: "https://dash.example.com/servers/7",
    kind: "click", element: "button", label: "Delete server", method: "GET",
  };
  const d = classifyInteraction(del);
  d.decision === "approval_required" && d.rule === "destructive"
    ? ok(`it stops, and says why: "${d.reason}"`)
    : bad(`a delete button was allowed: ${JSON.stringify(d)}`);

  let ran = 0;
  const attempt = (i: Interaction, approvalId?: string) =>
    gatedInteraction(pool, { projectId: pid, interaction: i, approvalId }, async () => { ran += 1; });

  const blocked = await attempt(del);
  !blocked.performed
    ? ok("and the click does not happen")
    : bad("the gate refused and clicked anyway");
  ran === 0 ? ok("the browser was never touched") : bad(`perform ran ${ran} time(s)`);

  console.log("");
  console.log("3. approved, it proceeds and records what it clicked");
  const approved = await attempt(del, "00000000-0000-4000-8000-000000000042");
  approved.performed ? ok("with an approval attached, it goes ahead") : bad("an approved click was still refused");
  ran === 1 ? ok("and the click happened exactly once") : bad(`perform ran ${ran} time(s)`);

  const row = (await pool.query<{
    url: string; label: string; element: string; decision: string; rule: string; approval_id: string | null;
  }>(
    `SELECT url, label, element, decision, rule, approval_id FROM browser_actions
      WHERE id = $1`, [approved.actionId])).rows[0];
  row?.url === del.url && row.label === "Delete server" && row.element === "button"
    ? ok(`the row says what it clicked: ${row.element} "${row.label}" on ${row.url}`)
    : bad(`the row does not describe the click: ${JSON.stringify(row)}`);
  /*
   * An approval satisfies a stop; it does not rewrite history into an allow.
   * "This needed a person and got one" and "this never needed anyone" are
   * different facts, and only one of them is reassuring a month later.
   */
  row?.decision === "approval_required" && row.approval_id !== null
    ? ok("and still records that it NEEDED a person, with the approval beside it")
    : bad(`the approved row reads as ${row?.decision}, losing the fact that it was gated`);

  const refused = (await pool.query<{ decision: string; reason: string }>(
    `SELECT decision, reason FROM browser_actions WHERE id = $1`, [blocked.actionId])).rows[0];
  refused?.decision === "refused" && refused.reason.includes("no approval")
    ? ok("while the refused attempt is recorded as refused, with the reason")
    : bad(`the refusal was not recorded properly: ${JSON.stringify(refused)}`);

  console.log("");
  console.log("4. it stops rather than guessing");
  stops({ url: "u", kind: "click", element: "button", label: "OK" })
    ? ok('an ambiguous label ("OK") stops')
    : bad("an ambiguous control was allowed");
  stops({ url: "u", kind: "click", element: "button", label: "" })
    ? ok("an unlabelled control stops, because there is nothing to judge")
    : bad("an unlabelled control was allowed");
  stops({ url: "u", kind: "click", element: "button", label: "Continue" })
    ? ok('"Continue" stops — it sits on a save button and a delete confirmation alike')
    : bad('"Continue" was allowed');

  console.log("");
  console.log("5. the mechanism, not just the words");
  /*
   * Asserted on the RULE, not just on the decision, and that distinction is not
   * pedantry: deleting the submit branch entirely left this test green, because
   * "submit" then fell through to the unknown-kind catch-all and stopped for a
   * completely different reason. The assertion was satisfied by the safety net
   * rather than by the rule it claimed to be testing - which is the shape of a
   * test that passes for the wrong reason, found by sabotaging it.
   */
  classifyInteraction({ url: "u", kind: "submit", element: "form", label: "Save" }).rule === "submit"
    ? ok('every form submit stops as a submit, even one labelled "Save"')
    : bad("a form submit was allowed, or stopped for the wrong reason");
  stops({ url: "u", kind: "click", element: "button", label: "Update preferences", method: "POST" })
    ? ok("a POST stops whatever it is called")
    : bad("a POST was allowed");
  /*
   * The label rules are a stop-list, never a safety proof. This is the case
   * that separates the two: a friendly label on a non-GET method must not talk
   * its way through, because a page controls its labels and does not control
   * what an HTTP method is.
   */
  classifyInteraction({ url: "u", kind: "click", label: "View details", method: "DELETE" }).rule === "method"
    ? ok("and the method decides it, not the friendly label on top")
    : bad("a friendly label overrode the method");

  console.log("");
  console.log("6. purchases and outbound reach are the same class of irreversible");
  stops({ url: "u", kind: "click", element: "button", label: "Place order" })
    ? ok("a purchase stops")
    : bad("a purchase was allowed");
  stops({ url: "u", kind: "click", element: "button", label: "Send invitation" })
    ? ok("and so does something that reaches another person")
    : bad("an outbound action was allowed");

  console.log("");
  console.log("7. production changes nothing about the surface");
  stops({ url: "u", kind: "click", element: "a", label: "View logs", production: true })
    ? ok("an otherwise-harmless click on a production system stops")
    : bad("a production interaction was allowed without approval");
  !stops({ url: "u", kind: "read", production: true })
    ? ok("while reading production is still free")
    : bad("reading a production page asked for approval");

  console.log("");
  console.log("8. a kind nobody wrote a rule for stops");
  /*
   * The default has to be the safe answer rather than an exception: a new
   * interaction kind added a year from now, by someone who did not read this
   * file, must not arrive as an unhandled throw or as a silent allow.
   */
  stops({ url: "u", kind: "drag" as Interaction["kind"], label: "Reorder" })
    ? ok("an unrecognised interaction kind stops instead of falling through")
    : bad("an unknown interaction kind was allowed");

  console.log("");
  console.log("9. the ordinary browsing that led up to it is recorded too");
  await attempt({ url: "https://dash.example.com/servers", kind: "navigate" });
  /*
   * Asserted on the CONTENT of the trail rather than on a count. My first
   * version expected four rows and there are three - only the calls that go
   * through `gatedInteraction` write one, and everything in sections 4 to 8 is
   * the pure classifier - so the number was a fact about how the fixture is
   * written rather than about the gate. A count also passes for the wrong
   * reason the moment somebody adds a case above it.
   */
  const trail = (await pool.query<{ kind: string; decision: string }>(
    `SELECT kind, decision FROM browser_actions WHERE project_id = $1 ORDER BY at`, [pid])).rows;
  trail.some((r) => r.kind === "navigate" && r.decision === "allow")
    ? ok("the ordinary navigation that led up to the click is on the record too")
    : bad(`no allowed navigation was recorded: ${JSON.stringify(trail)}`);
  trail.filter((r) => r.kind === "click").length === 2
    ? ok("alongside both attempts at the click - the refused one and the approved one")
    : bad(`the click attempts are not both recorded: ${JSON.stringify(trail)}`);

  await pool.query(`DELETE FROM browser_actions WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [pid]);

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

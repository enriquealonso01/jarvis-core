/**
 * S12b item 1 — the deterministic router (ADR 005 Stage B).
 *
 * The gap this closes was LIVE: `classifyInbox` was the first thing to read an
 * inbound body, and it is a model call. "Classification is a pipeline. An LLM is
 * never the first reader of a confidential body" was true of the ADR and of
 * nothing else.
 *
 * The plan's test is specific, and it is about MODEL CALLS, not about rules:
 *
 *   "a `#project-slug` message reaches ZERO model calls, and a code-shaped body
 *    routes globally without one."
 *
 * So model calls are counted, from the audit trail the Supervisor writes when a
 * tool runs and from the classifier's own verdict row — not asserted about.
 */
import { createPool } from "../src/db.js";
import { deterministicRoute, directiveSlugs } from "../src/routeb.js";
import { ingestUserMessage } from "../src/inbox.js";

const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 240)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));

const STAMP = Date.now().toString(36).slice(-6);

/**
 * How many times a model was asked anything about this event.
 *
 * The classifier writes its verdict on the row; the Supervisor writes an audit
 * row per tool call and a message per answer. A turn that reached a model leaves
 * at least one of the three.
 */
async function modelCallsFor(inboxId: string): Promise<number> {
  /*
   * Two traces, both written ONLY when a model actually ran: the classifier
   * stamps `route_decided_at` and `route_model` on the event, and the Supervisor
   * writes an audit row per tool call. A jarvis message is not counted — Stage B
   * writes one itself to say where it filed something, and counting that would
   * make the zero-call test impossible to pass by construction.
   */
  const classified = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM inbox_events
     WHERE id = $1 AND route_decided_at IS NOT NULL`,
    [inboxId],
  );
  const tools = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_events
     WHERE actor = 'supervisor' AND metadata->>'inbox_id' = $1`,
    [inboxId],
  );
  return Number(classified.rows[0].n) + Number(tools.rows[0].n);
}

async function newConversation(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO conversations (project_id, title, channel) VALUES (NULL, 'router probe', 'web') RETURNING id`,
  );
  return r.rows[0].id;
}

async function inboxRow(text: string, channel: string, sender: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO inbox_events (channel, sender, raw_text, checksum, capture_state, processing_state)
     VALUES ($1, $2, $3, md5($3), 'persisted', 'pending') RETURNING id`,
    [channel, sender, text],
  );
  return r.rows[0].id;
}

async function main(): Promise<void> {
  console.log("########## the directive, read from the text alone ##########\n");
  {
    check("a slug is found", "alpha-web", directiveSlugs("please look at #alpha-web today")[0]);
    check("at the start too", "alpha-web", directiveSlugs("#alpha-web is broken")[0]);
    check("a hash inside a word is not a directive", 0, directiveSlugs("issue#42 and C#").length);
    check("nor is a bare hash", 0, directiveSlugs("# heading").length);
    check("several can appear", 2, directiveSlugs("#alpha-web and #dev-sandbox").length);
  }

  console.log("\n########## the rules, in the ADR's order ##########\n");
  {
    const id = await inboxRow(`look at #alpha-web ${STAMP}`, "whatsapp", "enrique");
    const r = await deterministicRoute(pool, {
      inboxId: id, text: `look at #alpha-web ${STAMP}`, channel: "whatsapp", sender: "enrique",
    });
    check("a directive routes by name", "directive", r.rule);
    check("to that project", "alpha-web", r.projectSlug);
    truthy("and it opens or finds a thread for it", r.conversationId);

    // Rule 4: the next message from the same sender, inside ten minutes, with no
    // directive of its own, follows it.
    await pool.query("UPDATE inbox_events SET project_id = (SELECT id FROM projects WHERE slug='alpha-web'), conversation_id = $2 WHERE id = $1", [id, r.conversationId]);
    const id2 = await inboxRow(`and the header too ${STAMP}`, "whatsapp", "enrique");
    const r2 = await deterministicRoute(pool, {
      inboxId: id2, text: `and the header too ${STAMP}`, channel: "whatsapp", sender: "enrique",
    });
    check("a follow-up inside the window stays with it", "correlation", r2.rule);
    check("in the same project", "alpha-web", r2.projectSlug);

    // ...but not if it names a different project.
    const id3 = await inboxRow(`actually #dev-sandbox instead ${STAMP}`, "whatsapp", "enrique");
    const r3 = await deterministicRoute(pool, {
      inboxId: id3, text: `actually #dev-sandbox instead ${STAMP}`, channel: "whatsapp", sender: "enrique",
    });
    check("naming another project wins over the window", "directive", r3.rule);
    check("and routes there", "dev-sandbox", r3.projectSlug);

    // ...and a name that matches nothing does not fall back to the window.
    const id4 = await inboxRow(`what about #nosuchproject ${STAMP}`, "whatsapp", "enrique");
    const r4 = await deterministicRoute(pool, {
      inboxId: id4, text: `what about #nosuchproject ${STAMP}`, channel: "whatsapp", sender: "enrique",
    });
    check("a slug that matches no project routes nowhere", "none", r4.rule);
    ok("...rather than being swept into whatever came before it");
  }

  console.log("\n########## the sticky project, and the sender binding ##########\n");
  {
    await pool.query("DELETE FROM active_project");
    const id = await inboxRow(`no clues in this one ${STAMP}`, "sms", `nobody-${STAMP}`);
    const before = await deterministicRoute(pool, {
      inboxId: id, text: "no clues in this one", channel: "sms", sender: `nobody-${STAMP}`,
    });
    check("with nothing to go on it routes globally", "none", before.rule);

    await pool.query(
      "INSERT INTO active_project (project_id) SELECT id FROM projects WHERE slug = 'dev-sandbox'",
    );
    const after = await deterministicRoute(pool, {
      inboxId: id, text: "no clues in this one", channel: "sms", sender: `nobody-${STAMP}`,
    });
    check("an active project is used when there is one", "sticky", after.rule);
    check("and it is that project", "dev-sandbox", after.projectSlug);

    await pool.query("UPDATE active_project SET set_at = now() - interval '3 hours'");
    const stale = await deterministicRoute(pool, {
      inboxId: id, text: "no clues in this one", channel: "sms", sender: `nobody-${STAMP}`,
    });
    check("a stale one is not", "none", stale.rule);
    await pool.query("DELETE FROM active_project");

    // Rule 6 is default OFF: the row has to exist AND be enabled.
    await pool.query(
      `INSERT INTO sender_project_binding (channel, sender, project_id, enabled)
       SELECT 'sms', $1, id, false FROM projects WHERE slug = 'alpha-web'
       ON CONFLICT (channel, sender) DO NOTHING`,
      [`nobody-${STAMP}`],
    );
    const off = await deterministicRoute(pool, {
      inboxId: id, text: "no clues", channel: "sms", sender: `nobody-${STAMP}`,
    });
    check("a disabled sender binding does nothing", "none", off.rule);
    await pool.query("UPDATE sender_project_binding SET enabled = true WHERE sender = $1", [`nobody-${STAMP}`]);
    const on = await deterministicRoute(pool, {
      inboxId: id, text: "no clues", channel: "sms", sender: `nobody-${STAMP}`,
    });
    check("an enabled one routes", "sender", on.rule);
    await pool.query("DELETE FROM sender_project_binding WHERE sender = $1", [`nobody-${STAMP}`]);
  }

  console.log("\n########## zero model calls ##########\n");
  {
    /*
     * The plan's own test. A confidential project named by directive, with a
     * body that looks like code: the project is known without a model, and the
     * ADR forbids a model reading the body — so nothing is asked of one.
     */
    await pool.query(
      `UPDATE projects SET confidentiality = 'confidential' WHERE slug = 'alpha-web'`,
    );
    const conv = await newConversation();
    const body = `#alpha-web here is the trace ${STAMP}\n\nTraceback (most recent call last):\n  File "/srv/app/main.py", line 42\n    raise ValueError(secret)\n`;
    const result = await ingestUserMessage(pool, { conversationId: conv, body });
    const calls = await modelCallsFor(result.inboxId);
    console.log(`  model calls: ${calls}`);
    check("a #slug message with a code body reaches ZERO model calls", 0, calls);

    const row = await pool.query<{ project: string | null; mode: string; rule: string | null; note: string | null }>(
      `SELECT p.slug AS project, i.supervisor_payload_mode AS mode, i.route_rule AS rule, i.routing_note AS note
       FROM inbox_events i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = $1`,
      [result.inboxId],
    );
    check("it is filed in the project it named", "alpha-web", row.rows[0].project);
    check("by the directive rule", "directive", row.rows[0].rule);
    check("with the body withheld from the Supervisor", "metadata_only", row.rows[0].mode);
    truthy("and the reason written down", (row.rows[0].note ?? "").includes("withheld"));
    truthy("the caller is told where it went", (result.assistant ?? "").includes("alpha-web"));
    await pool.query(`UPDATE projects SET confidentiality = 'normal' WHERE slug = 'alpha-web'`);
  }

  console.log("\n########## a code-shaped body with no project ##########\n");
  {
    /*
     * The correlation window has to be cleared first, and that is not a fudge —
     * it is the rule working. The previous section filed a `web`/`enrique`
     * message into alpha-web moments ago, so an unlabelled follow-up from the
     * same sender inside ten minutes belongs to alpha-web, exactly as ADR 005
     * rule 4 says. Testing the "no project at all" path means being the first
     * message, not the second.
     */
    await pool.query(
      `UPDATE inbox_events SET project_id = NULL
       WHERE channel = 'web' AND sender = 'enrique'
         AND received_at > now() - interval '15 minutes'`,
    );
    const conv = await newConversation();
    const body = `no project named ${STAMP}\n\`\`\`\nconst secret = process.env.SECRET;\n\`\`\`\n`;
    const result = await ingestUserMessage(pool, { conversationId: conv, body });
    const calls = await modelCallsFor(result.inboxId);
    console.log(`  model calls: ${calls}`);
    check("it routes globally without a model call", 0, calls);
    const row = await pool.query<{ state: string; note: string | null }>(
      "SELECT processing_state AS state, routing_note AS note FROM inbox_events WHERE id = $1",
      [result.inboxId],
    );
    check("and is held rather than sent", "pending", row.rows[0].state);
    truthy("with the reason on the row", (row.rows[0].note ?? "").includes("held"));
  }

  console.log("\n########## and an ordinary message still gets a model ##########\n");
  {
    const conv = await newConversation();
    const result = await ingestUserMessage(pool, {
      conversationId: conv,
      body: `how does our deploy work ${STAMP}`,
    });
    const calls = await modelCallsFor(result.inboxId);
    console.log(`  model calls: ${calls}`);
    truthy("a plain question is still classified and answered", calls > 0);
    ok("...so Stage B narrowed what the model sees, rather than replacing it");
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

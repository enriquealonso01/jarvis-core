/**
 * S40 — the execution brief.
 *
 *   "A multi-step request produces a brief of four lines or fewer, naming the
 *    channel for each handoff. A trivial request produces **no** brief.
 *    **Briefing a one-step task is the failure mode here.** Changing the plan in
 *    reply ('send it to the console instead') changes the execution."
 *
 *   Debug: "If briefs read like task lists, the prompt is exposing the step
 *    decomposition. The brief describes the *user-facing* flow; the
 *    decomposition is internal and stays that way."
 *
 * Three of these are easy to assert weakly, so each is done the awkward way:
 *
 *  - "no internal steps" is not asserted by reading a brief and not finding any.
 *    It is asserted by handing the projection a field nobody has ever seen and
 *    checking it does not come out the other side — which is what tells the
 *    difference between a projection that names what it keeps and one that
 *    copies the object and deletes the field it knows about.
 *
 *  - "four lines or fewer" is not asserted alone, because truncation satisfies
 *    it. It is asserted together with a count: every point where the work waits
 *    for him is named in the text or included in the folded number, and the two
 *    must add up to the number of them.
 *
 *  - "changes the execution" is not asserted by re-reading what `redirect()`
 *    returned. It is asserted by reading the row execution reads.
 */
import { createPool } from "../src/db.js";
import {
  afterBrief, applyRedirect, composeBrief, InternalTask, MAX_BRIEF_LINES,
  needsBrief, planForExecution, recordBrief, userFacing,
} from "../src/brief.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s40b-${Math.random().toString(36).slice(2, 7)}`;
const NOW = new Date("2026-09-05T09:00:00Z");

/** The plan's own worked example, as a task the executor would hold. */
const INTEGRATION: InternalTask = {
  intent: "set up the supplier integration",
  steps: [
    { description: "provision an oauth client against the vendor console", tool: "browser" },
    { description: "poll the token endpoint until the grant lands", tool: "http" },
    { description: "write the credential into the connections table", tool: "postgres" },
    { description: "run a smoke invocation and record the latency", tool: "connector" },
  ],
  handoffs: [
    { what: "the auth link", channel: "whatsapp", needsHim: true },
  ],
  completion: { channel: "whatsapp" },
};

/** "Briefing a one-step task is the failure mode here." */
const TRIVIAL: InternalTask = {
  intent: "check whether the nightly restore drill passed",
  steps: [{ description: "read the last drill row", tool: "postgres" }],
  handoffs: [{ what: "tell you the answer", channel: "whatsapp", needsHim: false }],
  completion: { channel: "whatsapp" },
};

/** Five points that wait for him. More than can possibly get a line each. */
const LONG: InternalTask = {
  intent: "move the three suppliers onto the new contract terms",
  steps: [{ description: "iterate suppliers", tool: "postgres" }],
  handoffs: [
    { what: "the first supplier's terms to approve", channel: "whatsapp", needsHim: true },
    { what: "the second supplier's terms to approve", channel: "whatsapp", needsHim: true },
    { what: "the countersignature request", channel: "console", needsHim: true },
    { what: "the revised schedule to sign off", channel: "console", needsHim: true },
    { what: "the final packet", channel: "phone", needsHim: true },
    { what: "file the paperwork", channel: "console", needsHim: false },
  ],
  completion: { channel: "whatsapp" },
};

const CHANNEL_WORDS = ["WhatsApp", "the phone", "the console"];

async function main(): Promise<void> {
  const project = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG])).rows[0].id;
  const conversation = (await pool.query<{ id: string }>(
    `INSERT INTO conversations (project_id, title, channel, channels, last_activity_at)
     VALUES ($1,$2,'whatsapp',ARRAY['whatsapp'],$3) RETURNING id`,
    [project, `${SLUG} thread`, NOW])).rows[0].id;

  const briefsFor = async () => Number((await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM briefs WHERE project_id = $1`, [project])).rows[0].n);

  try {
    console.log("1. a multi-step request gets a brief, four lines or fewer");
    const plan = userFacing(INTEGRATION);
    const brief = composeBrief(plan);
    if (!brief) {
      bad("a request that needs him produced no brief at all");
    } else {
      brief.lines.length <= MAX_BRIEF_LINES
        ? ok(`${brief.lines.length} lines: "${brief.text.replace(/\n/g, " / ")}"`)
        : bad(`${brief.lines.length} lines, over the limit of ${MAX_BRIEF_LINES}`);
      /*
       * "naming the channel for each handoff" — asserted per LINE rather than
       * over the whole text, because a brief that names WhatsApp once and then
       * describes two more handoffs without saying where they arrive passes any
       * assertion made against the text as a whole.
       */
      const handoffLines = brief.lines.slice(1);
      handoffLines.every((l) => CHANNEL_WORDS.some((w) => l.includes(w)))
        ? ok("and every line after the intent names the surface it arrives on")
        : bad(`a line names no channel: ${JSON.stringify(handoffLines)}`);
      brief.text.includes("when it's done")
        ? ok("including how he will hear that it finished")
        : bad("the brief never says how completion is reported");
    }

    /*
     * One handoff, but it WAITS FOR HIM. The plan's failure mode is briefing a
     * one-step task, not briefing a task with one interruption — he is about to
     * be asked for something and telling him so is the entire feature.
     */
    needsBrief(plan)
      ? ok("one handoff still earns a brief when the work stops until he acts")
      : bad("a request that will wait for him was treated as trivial");

    console.log("");
    console.log("2. a trivial request produces no brief, and no row");
    composeBrief(userFacing(TRIVIAL)) === null
      ? ok("nothing to brief when he is told once, at the end")
      : bad(`a one-step task was briefed: ${JSON.stringify(composeBrief(userFacing(TRIVIAL)))}`);
    const nothing = await recordBrief(pool, {
      task: TRIVIAL, projectId: project, conversationId: conversation, now: NOW,
    });
    nothing === null ? ok("and recordBrief returns null rather than an empty brief") : bad("a trivial task recorded a brief");
    (await briefsFor()) === 0
      ? ok("no row was written either, so nothing can report on it later")
      : bad(`${await briefsFor()} brief rows exist for a trivial request`);

    console.log("");
    console.log("3. the decomposition does not travel");
    const projected = userFacing(INTEGRATION);
    !Object.hasOwn(projected, "steps")
      ? ok("the projection has no steps field")
      : bad("userFacing() carried the step list through");
    const leaked = INTEGRATION.steps.filter((s) =>
      composeBrief(projected)?.text.includes(s.description.slice(0, 18)));
    leaked.length === 0
      ? ok("and no step description reaches the brief")
      : bad(`the brief reads like a task list: ${JSON.stringify(leaked)}`);
    /*
     * The assertion that separates a projection which NAMES WHAT IT KEEPS from
     * one that copies the task and deletes the field it happens to know about.
     * The second form is right about today's fields and silently wrong about
     * the next one added — so it is tested with a field that does not exist
     * yet, exactly as the next one will not.
     */
    const withSecret = { ...INTEGRATION, credentialRef: "vault://supplier/oauth" } as InternalTask;
    const secretKeys = Object.keys(userFacing(withSecret));
    !secretKeys.includes("credentialRef")
      ? ok(`a field the projection has never heard of is dropped: kept ${secretKeys.join(", ")}`)
      : bad("an unknown internal field travelled into the user-facing plan");

    console.log("");
    console.log("4. what gets cut when the flow is long");
    const longBrief = composeBrief(userFacing(LONG));
    if (!longBrief) {
      bad("a five-handoff flow produced no brief");
    } else {
      longBrief.lines.length <= MAX_BRIEF_LINES
        ? ok(`still ${longBrief.lines.length} lines: "${longBrief.text.replace(/\n/g, " / ")}"`)
        : bad(`${longBrief.lines.length} lines for a long flow`);
      /*
       * Four-lines-or-fewer is trivially satisfied by throwing handoffs away, so
       * it is never asserted on its own. Every point that WAITS FOR HIM must be
       * accounted for: named in the text, or inside the folded count. Dropping
       * one means he discovers he was needed when the work has already stopped.
       */
      const blocking = LONG.handoffs.filter((h) => h.needsHim);
      const namedInText = blocking.filter((h) => longBrief.text.includes(h.what));
      namedInText.length + longBrief.foldedCount === blocking.length
        ? ok(`all ${blocking.length} points needing him are accounted for: ${namedInText.length} named, ${longBrief.foldedCount} counted`)
        : bad(`${namedInText.length} named + ${longBrief.foldedCount} folded ≠ ${blocking.length} that need him`);
      longBrief.foldedCount > 0 && longBrief.text.includes(String(longBrief.foldedCount))
        ? ok("and the number he is told is the number that was folded")
        : bad("the folded count is not in the text he receives");
      /*
       * The channels of the folded handoffs, not just of the named ones. Being
       * told "three more times" without being told where is how he ends up
       * watching the wrong surface.
       */
      const foldedChannels = [...new Set(blocking.slice(1).map((h) =>
        h.channel === "console" ? "the console" : h.channel === "phone" ? "the phone" : "WhatsApp"))];
      foldedChannels.every((c) => longBrief.text.includes(c))
        ? ok(`naming every surface they arrive on: ${foldedChannels.join(", ")}`)
        : bad(`folded handoffs arrive on ${foldedChannels.join(", ")}, unnamed in the brief`);
      /*
       * The informational handoff is the one that may go — he does not have to
       * do anything about it, and the completion line already covers it.
       */
      !longBrief.text.includes("file the paperwork")
        ? ok("while the line he does not have to act on is the one that was cut")
        : bad("an informational line survived at the expense of one needing him");
    }

    console.log("");
    console.log("5. it is not a permission gate");
    /*
     * Stated twice in the plan within four sentences, so it is asserted rather
     * than commented: "he can approve it, change it, or IGNORE IT... the
     * approval rules are S42's job, and this is not a second one."
     */
    afterBrief().proceed === true
      ? ok(`work proceeds after a brief: ${afterBrief().why}`)
      : bad("a brief blocks the work, which makes it a second approval gate");

    console.log("");
    console.log("6. changing the plan in reply changes the execution");
    const said = await recordBrief(pool, {
      task: INTEGRATION, projectId: project, conversationId: conversation, now: NOW,
    });
    if (!said) {
      bad("the integration request recorded no brief");
    } else {
      const before = await planForExecution(pool, said.id);
      before?.completion.channel === "whatsapp"
        ? ok("as briefed, the result goes to WhatsApp")
        : bad(`the stored plan says ${before?.completion.channel}`);

      await applyRedirect(pool, said.id, { channel: "console" }, NOW);

      /*
       * Read back from the row EXECUTION reads, not from what applyRedirect
       * returned. A redirect that updates its own return value and leaves the
       * stored plan alone passes every assertion made against the return value,
       * and the message still arrives on WhatsApp.
       */
      const after = await planForExecution(pool, said.id);
      after?.completion.channel === "console"
        ? ok("after 'send it to the console instead', execution reads the console")
        : bad(`REDIRECT DID NOT REACH EXECUTION: still ${after?.completion.channel}`);
      after?.handoffs.every((h) => h.channel === "console")
        ? ok("and the handoff along the way moved with it")
        : bad(`handoffs still on ${JSON.stringify(after?.handoffs.map((h) => h.channel))}`);

      const row = (await pool.query<{ brief_text: string; redirected_at: Date | null }>(
        `SELECT brief_text, redirected_at FROM briefs WHERE id = $1`, [said.id])).rows[0];
      row.brief_text === said.brief.text
        ? ok("what was said stays said — the brief text is not rewritten to match")
        : bad("the redirect rewrote history: the stored brief now shows a plan he never received");
      row.redirected_at !== null
        ? ok("and the row records that he redirected rather than ignored it")
        : bad("a redirect is indistinguishable from being ignored");
    }
  } finally {
    await pool.query(`DELETE FROM briefs WHERE project_id = $1`, [project]);
    await pool.query(`DELETE FROM conversations WHERE id = $1`, [conversation]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project]);
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

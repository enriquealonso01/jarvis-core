/**
 * S42 — an objection is not a refusal, and the plan only had refusals.
 *
 *   "**Ask for something authorised and destructive** — skip the tests, drop
 *    retention to a day — and confirm **one sentence, then the work happens
 *    anyway.** Ask again and confirm it does **not** object twice. Ask for
 *    something authorised and merely not-to-taste → **no objection at all.** An
 *    objection never converts into a block: the task starts in the same message."
 *
 * The assertion that is easiest to fake is "it does not block", because a
 * function that returns a sentence looks non-blocking whatever it does. So it is
 * asserted twice and in two different ways: on the value (`proceed` is `true`),
 * and on the shape of the module (there is no denial anywhere in what it can
 * return). The second is what survives somebody later adding a branch.
 */
import { createPool } from "../src/db.js";
import {
  GROUNDS, MAX_OBJECTION_CHARS, objectionFingerprint, objectionRecord,
  objectionSentence, objectOnce, judgeObjection,
} from "../src/objection.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s42o-${Math.random().toString(36).slice(2, 7)}`;

async function main(): Promise<void> {
  const project = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG])).rows[0].id;

  try {
    console.log("1. authorised and destructive: one sentence, then it happens");
    const first = await objectOnce(pool, {
      projectId: project, action: "retention.shorten", ground: "data_loss",
      what: "dropping retention to a day",
    });
    if (!first) {
      bad("nothing was said about dropping retention to a day");
    } else {
      first.proceed === true
        ? ok(`it says something and the work goes ahead: "${first.sentence}"`)
        : bad("the objection did not proceed");
      /*
       * One sentence. "Say it once, IN ONE SENTENCE, and then do it." A
       * paragraph is an argument, and an argument is a thing he has to answer.
       */
      const terminators = (first.sentence.match(/[.!?]/g) ?? []).length;
      terminators === 1 && first.sentence.length <= MAX_OBJECTION_CHARS
        ? ok(`one sentence, ${first.sentence.length} characters`)
        : bad(`${terminators} sentences, ${first.sentence.length} chars`);
      /*
       * It is about consequence, not preference. "I would have structured it
       * differently" is the thing this must never sound like.
       */
      /loses data|cannot be undone|You asked me/.test(first.sentence)
        ? ok("and it names the consequence rather than a preference")
        : bad(`the sentence editorialises: ${first.sentence}`);
      first.sentence.includes("doing it now")
        ? ok("while saying, in the same breath, that it is going ahead")
        : bad("the sentence reads like a question waiting for an answer");
    }

    console.log("");
    console.log("2. and not twice");
    const again = await objectOnce(pool, {
      projectId: project, action: "retention.shorten", ground: "data_loss",
      what: "dropping retention to a day",
    });
    again === null
      ? ok("asking again says nothing — the work simply happens")
      : bad(`it objected twice: "${again.sentence}"`);
    /*
     * Enforced by a unique index rather than SELECT-then-INSERT: two requests
     * arriving together would both find nothing and both speak.
     */
    const concurrent = await Promise.all([
      objectOnce(pool, { projectId: project, action: "tests.skip", ground: "his_own_rule", what: "pushing without the suite", rule: "always run the suite" }),
      objectOnce(pool, { projectId: project, action: "tests.skip", ground: "his_own_rule", what: "pushing without the suite", rule: "always run the suite" }),
    ]);
    concurrent.filter(Boolean).length === 1
      ? ok("two simultaneous requests produce exactly one sentence, not two")
      : bad(`${concurrent.filter(Boolean).length} objections from a race`);

    console.log("");
    console.log("3. taste is not an objection");
    /*
     * "'I would have structured it differently' is not - taste is not an
     * objection, and a Jarvis that editorialises is one he stops reading."
     * Silence, rather than a softer sentence.
     */
    for (const ground of ["style", "preference", "minor", "would_have_done_differently", ""]) {
      const nothing = await objectOnce(pool, {
        projectId: project, action: "refactor.shape", ground, what: "structuring it that way",
      });
      nothing === null
        ? ok(`"${ground || "(none)"}" is not a ground, so nothing is said`)
        : bad(`it editorialised on ${ground}: ${nothing.sentence}`);
    }
    GROUNDS.length === 3 && GROUNDS.every((g) => ["data_loss", "irreversible", "his_own_rule"].includes(g))
      ? ok(`the bar is a closed set of three: ${GROUNDS.join(", ")}`)
      : bad(`the grounds have drifted: ${GROUNDS.join(", ")}`);

    console.log("");
    console.log("4. it never becomes a refusal");
    /*
     * Asserted on the value AND on what the function can return at all. "If the
     * action genuinely is not allowed, that is the gate's job... mixing the two
     * means he cannot tell whether Jarvis is asking or blocking."
     */
    const worst = await objectOnce(pool, {
      projectId: project, action: "project.delete", ground: "irreversible",
      what: "deleting that project",
    });
    worst?.proceed === true
      ? ok("even the most irreversible thing on the list proceeds")
      : bad("an objection blocked the work");
    worst && !("blocked" in worst) && !("denied" in worst) && !("approvalRequired" in worst)
      ? ok("and the result has no way to say otherwise — no blocked, denied or approvalRequired")
      : bad("the objection carries a denial field");
    Object.keys(worst ?? {}).sort().join(",") === "ground,proceed,sentence"
      ? ok(`what it can return is exactly: ${Object.keys(worst ?? {}).sort().join(", ")}`)
      : bad(`unexpected shape: ${Object.keys(worst ?? {}).join(",")}`);

    console.log("");
    console.log("5. the same practice on another project is a different objection");
    /*
     * Keyed on the practice, not the occasion. Per-task would let the same
     * sentence arrive on every task forever; global-per-action would silence a
     * genuinely new project because an old one heard it once.
     */
    const other = (await pool.query<{ id: string }>(
      `INSERT INTO projects (slug,name,project_type,confidentiality)
       VALUES ($1,$1,'personal','normal') RETURNING id`, [`${SLUG}-2`])).rows[0].id;
    try {
      const elsewhere = await objectOnce(pool, {
        projectId: other, action: "retention.shorten", ground: "data_loss",
        what: "dropping retention to a day",
      });
      elsewhere !== null
        ? ok("a different project hears it once too")
        : bad("one project's objection silenced another's");
      objectionFingerprint({ projectId: project, action: "a", ground: "data_loss" })
        !== objectionFingerprint({ projectId: other, action: "a", ground: "data_loss" })
        ? ok("because the fingerprint is per project, action and ground")
        : bad("the fingerprint ignores the project");
      objectionFingerprint({ projectId: project, action: "a", ground: "data_loss" })
        !== objectionFingerprint({ projectId: project, action: "a", ground: "irreversible" })
        ? ok("and a different ground is a different thing to say")
        : bad("two grounds share a fingerprint");
    } finally {
      await pool.query(`DELETE FROM objections WHERE project_id = $1`, [other]);
      await pool.query(`DELETE FROM projects WHERE id = $1`, [other]);
    }

    console.log("");
    console.log("6. were they right?");
    /*
     * "Objections are recorded, which makes S48 able to ask the only question
     * that matters about them: were they right? A Jarvis that objects and is
     * usually wrong should object less."
     */
    const before = await objectionRecord(pool, project);
    before.judged === 0
      ? ok("an objection nobody has ruled on counts as neither right nor wrong")
      : bad(`unjudged objections are being counted: ${JSON.stringify(before)}`);
    await judgeObjection(pool, objectionFingerprint({
      projectId: project, action: "retention.shorten", ground: "data_loss",
    }), true);
    const after = await objectionRecord(pool, project);
    after.judged === 1 && after.right === 1
      ? ok("once judged, it becomes a measurable record rather than a matter of tone")
      : bad(`record: ${JSON.stringify(after)}`);
    /*
     * NULL is not false. An unjudged objection defaulting to wrong would let the
     * rate answer S48's question in the flattering direction on its own.
     */
    const stillNull = Number((await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM objections WHERE project_id = $1 AND was_right IS NULL`,
      [project])).rows[0].n);
    stillNull > 0
      ? ok(`and ${stillNull} others stay unjudged rather than defaulting to either`)
      : bad("every objection was given a verdict nobody made");

    console.log("");
    console.log("7. the sentence for a rule he set himself");
    const rule = objectionSentence({
      ground: "his_own_rule", what: "pushing without the suite",
      rule: "always run the suite",
    });
    rule.includes("You asked me to always run the suite")
      ? ok(`it quotes his own rule back: "${rule}"`)
      : bad(`the rule is not named: ${rule}`);
    objectionSentence({ ground: "data_loss", what: "x".repeat(400) }).length <= MAX_OBJECTION_CHARS
      ? ok("and a long subject is still one sentence, not a paragraph")
      : bad("a long subject produced an argument");
  } finally {
    await pool.query(`DELETE FROM objections WHERE project_id = $1`, [project]);
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

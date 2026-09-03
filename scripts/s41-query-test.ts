/**
 * S41 — finding the document, and stamping the transcript.
 *
 * The rule half of S41 shipped first: how a document is SAID. This is the half
 * that decides WHICH, against real rows.
 *
 *   "Produce a report, then ask for it by relative date on the phone three days
 *    later → the right document... Ask for something that does not exist → says
 *    so, does not improvise... Ask for 'the one about X' with no date → finds it
 *    by content."
 *
 * The assertion that carries the most weight is the last one in section 4: a
 * transcript of a confidential discussion, recalled later, is not read aloud —
 * asserted end to end through the outbound TTS payload rather than by checking
 * the column, because the column being right and the speech path ignoring it is
 * exactly the leak the plan describes.
 */
import { createPool } from "../src/db.js";
import {
  classificationOf, findDocuments, recallForVoice, shapeOf, stampTranscript, titleOf,
} from "../src/recall.js";
import { ttsPayload, voiceRendering } from "../src/voicerecall.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s41q-${Math.random().toString(36).slice(2, 7)}`;
const NOW = new Date("2026-09-08T21:30:00Z");
const daysAgo = (n: number, h = 9) =>
  new Date(Date.UTC(2026, 8, 8 - n, h, 0, 0));

const SECRET = "the Hensel penalty clause";

async function main(): Promise<void> {
  const mk = async (slug: string, conf: string) => (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal',$2) RETURNING id`, [slug, conf])).rows[0].id;
  const normal = await mk(`${SLUG}-n`, "normal");
  const secret = await mk(`${SLUG}-c`, "confidential");

  const artifact = async (project: string | null, path: string, at: Date, body: string) => {
    const a = (await pool.query<{ id: string }>(
      `INSERT INTO artifacts (project_id, path, sha256, mime, bytes, source, artifact_type, created_at)
       VALUES ($1,$2,$3,'text/markdown',$4,'agent','report',$5) RETURNING id`,
      [project, path, `${SLUG}-${path}`, body.length, at])).rows[0].id;
    /*
     * No `search` column here: it is GENERATED from body. Supplying it is an
     * error rather than a redundancy, which is the better design and was worth
     * discovering by being refused.
     */
    await pool.query(
      `INSERT INTO knowledge_chunks (project_id, body, source_artifact_id, kind, char_offset, chunk_index, created_at)
       VALUES ($1,$2,$3,'document',0,0,$4)`,
      [project, body, a, at]);
    return a;
  };

  let scraping = "";
  let alpha = "";
  let old = "";

  /*
   * Fixtures are created INSIDE the try. Built before it, a failure in the
   * third one leaves the first two and both projects behind - which is exactly
   * the litter no-test-litter-test exists to catch, produced by the suite that
   * was meant to be careful.
   */
  try {
    scraping = await artifact(normal, `${SLUG}/scraper-throughput-report.md`, daysAgo(2),
      "# Scraper throughput\n\nRecommendation: leave the schedule alone\n\n## Option one\n## Option two\n- tradeoff: cost\n- tradeoff: latency\nThe overnight scraping run finished in forty minutes.");
    alpha = await artifact(secret, `${SLUG}/alpha-migration-report.md`, daysAgo(2, 14),
      `# Alpha migration\n\nRecommendation: option two, mostly on cost\n\n## Option one\n## Option two\n## Option three\n- tradeoff: a\n- tradeoff: b\n- tradeoff: c\nWe cannot take option one because ${SECRET} applies.`);
    old = await artifact(normal, `${SLUG}/last-week-notes.md`, daysAgo(9),
      "# Old notes\n\nNothing about the same subjects at all.");

    console.log("1. by relative date");
    const twoDaysAgo = await findDocuments(pool, { when: "two days ago", now: NOW, projectId: null, limit: 20 });
    /*
     * Filtered to THIS RUN'S three documents, `old` included. The first version
     * listed only the two that should match, which meant a widened date window
     * returned `old` and the filter quietly dropped it again - the assertion
     * could not fail in the direction it existed to check. Sabotaging the
     * window is what found that.
     */
    const ours = new Set([scraping, alpha, old]);
    const mine = twoDaysAgo.filter((d) => ours.has(d.artifactId));
    mine.length === 2
      ? ok("both documents written that day are found, and the nine-day-old one is not")
      : bad(`found ${mine.length} from two days ago: ${mine.map((d) => d.title).join(", ")}`);
    !mine.some((d) => d.artifactId === old) ? ok("the older document is outside the window") : bad("an old document was returned");
    /*
     * Newest first. Two matches for "two days ago" means the later one, and a
     * recall that silently returns the earlier is wrong in the way hardest to
     * notice.
     */
    mine[0]?.artifactId === alpha
      ? ok("newest first, so the later of two same-day documents leads")
      : bad("results are not newest-first");
    /*
     * He asks at 21:30 for something written at 09:00. An instant-anchored
     * window would have excluded it; a whole-day one does not.
     */
    mine.some((d) => d.artifactId === scraping)
      ? ok("a morning document is found by an evening question")
      : bad("the morning document fell outside the evening query");

    console.log("");
    console.log("2. by content, with no date at all");
    const about = await findDocuments(pool, { about: "scraping", now: NOW, limit: 20 });
    about.some((d) => d.artifactId === scraping) && !about.some((d) => d.artifactId === alpha)
      ? ok("'the one about scraping' finds it by content and not the other one")
      : bad(`about scraping -> ${about.map((d) => d.title).join(", ")}`);
    const both = await findDocuments(pool, { about: "option", when: "two days ago", now: NOW, limit: 20 });
    both.length >= 2 ? ok("date and content together narrow rather than conflict") : bad("combining date and content found nothing");

    console.log("");
    console.log("3. the shape is read from the body, so the speech never has to be");
    const a = (await findDocuments(pool, { about: "Hensel", now: NOW }))[0];
    a?.recommendation === "option two, mostly on cost"
      ? ok(`the conclusion is extracted: "${a.recommendation}"`)
      : bad(`recommendation=${a?.recommendation}`);
    a?.optionCount === 3 && a?.tradeoffCount === 3
      ? ok("and the shape is counted: three options, three tradeoffs")
      : bad(`shape: ${a?.optionCount} options, ${a?.tradeoffCount} tradeoffs`);
    shapeOf(null).recommendation === null && shapeOf("nothing structured").optionCount === null
      ? ok("while a document with no shape reports none rather than inventing one")
      : bad("shape was invented for an unstructured document");
    titleOf(`${SLUG}/alpha-migration-report.md`) === `alpha migration report`
      ? ok("and the title comes off the path readably")
      : bad(`title: ${titleOf(`${SLUG}/alpha-migration-report.md`)}`);

    console.log("");
    console.log("4. what reaches the synthesiser, end to end");
    const spoken = ttsPayload(voiceRendering(a));
    !spoken.text.includes(SECRET) && !spoken.text.includes("cannot take option one")
      ? ok("the confidential report's body does not reach the TTS payload")
      : bad(`THE BODY REACHED THE SYNTHESISER: ${spoken.text}`);
    spoken.text.includes("option two, mostly on cost") && spoken.text.includes("three")
      ? ok(`while the recommendation and shape do: "${spoken.text}"`)
      : bad(`the explanation says too little: ${spoken.text}`);
    /*
     * Titles come off filenames, so one ending in "report" plus a kind of
     * "report" says it twice. Someone driving hears a mistake, not a stutter.
     */
    !/report report/i.test(spoken.text)
      ? ok("and it does not say the kind twice when the title already ends in it")
      : bad(`stuttered: ${spoken.text}`);
    const normalDoc = (await findDocuments(pool, { about: "scraping", now: NOW }))[0];
    ttsPayload(voiceRendering(normalDoc)).text.includes("forty minutes")
      ? ok("and a normal report really is read out, or the rule is switched off")
      : bad("the normal document was withheld too");

    console.log("");
    console.log("5. a transcript inherits, and a later recall respects the stamp");
    const call = `s41-${Math.random().toString(36).slice(2, 8)}`;
    await pool.query(
      `INSERT INTO calls (call_control_id, call_leg_id, from_e164, state, started_at)
       VALUES ($1,$1,'+15550000000','ended',$2)`, [call, daysAgo(1)]);
    const transcript = await artifact(normal, `${SLUG}/call-transcript.md`, daysAgo(1),
      `Transcript. We went through the Alpha migration and ${SECRET}.`);

    const stamped = await stampTranscript(pool, {
      callControlId: call, transcriptArtifactId: transcript,
      discussedProjectIds: [normal, secret],
    });
    stamped.classification === "confidential"
      ? ok("a call touching confidential work stamps its transcript confidential")
      : bad(`stamp=${stamped.classification}`);
    const stored = (await pool.query<{ confidentiality: string | null; discussed: string[] }>(
      `SELECT a.confidentiality, c.discussed_projects AS discussed
         FROM artifacts a, calls c WHERE a.id = $1 AND c.call_control_id = $2`,
      [transcript, call])).rows[0];
    stored.confidentiality === "confidential"
      ? ok("written to the artifact, which is what downstream reads")
      : bad(`artifact stamp is ${stored.confidentiality}`);
    stored.discussed?.length === 2
      ? ok("and the evidence is written beside it, so the stamp can be justified later")
      : bad(`discussed_projects=${JSON.stringify(stored.discussed)}`);

    /*
     * THE ASSERTION THIS SECTION EXISTS FOR. The transcript is filed under a
     * NORMAL project - that is exactly the leak the plan describes, content
     * moving from a classified artifact into an unclassified transcript - so a
     * recall that read the project would read it aloud. Asserted through the
     * outbound payload, not by checking the column.
     */
    const recalled = await recallForVoice(pool, { about: "Hensel", now: NOW, projectId: normal });
    if (!recalled.found) {
      bad("the transcript could not be recalled at all");
    } else {
      recalled.document.projects[0] === "confidential"
        ? ok("recalling it later reads the STAMP, not the normal project it is filed under")
        : bad(`recalled as ${recalled.document.projects[0]} — the leak the plan describes`);
      const later = ttsPayload(voiceRendering(recalled.document));
      !later.text.includes(SECRET)
        ? ok("so a later voice recall will not read that transcript aloud either")
        : bad(`THE TRANSCRIPT WAS READ ALOUD: ${later.text}`);
    }
    classificationOf({ stamped: null, confidentiality: null }) === "restricted"
      ? ok("an artifact belonging to no project is not spoken on the strength of that absence")
      : bad("a projectless artifact defaulted to normal");

    console.log("");
    console.log("6. asking for what is not there");
    const miss = await recallForVoice(pool, { about: "a document nobody wrote", now: NOW });
    !miss.found && miss.say.includes("not going to guess")
      ? ok("says so, and says it will not improvise")
      : bad(`a miss produced ${JSON.stringify(miss)}`);
    const unparsed = await findDocuments(pool, { when: "some time back", now: NOW });
    unparsed.length === 0
      ? ok("and a date phrase nobody could parse returns nothing, rather than everything")
      : bad(`an unparsed date matched ${unparsed.length} documents`);
  } finally {
    await pool.query(`DELETE FROM knowledge_chunks WHERE project_id = ANY($1::uuid[])`, [[normal, secret]]);
    await pool.query(`DELETE FROM calls WHERE call_control_id LIKE 's41-%' AND from_e164 = '+15550000000'`);
    await pool.query(`DELETE FROM artifacts WHERE project_id = ANY($1::uuid[])`, [[normal, secret]]);
    await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [[normal, secret]]);
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

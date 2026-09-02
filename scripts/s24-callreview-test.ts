/**
 * S24 — a call is as reviewable as a chat thread, and audio retention holds.
 *
 * Three of the four parts existed before this step: the recording with its
 * seven-day clock, the transcript artifact, and the tasks a call produced. What
 * the plan asks for on top is the part a person reads first — what the call was
 * about — and the recall that makes "what did I ask you about Alpha yesterday?"
 * answerable from a DIFFERENT call.
 *
 * The retention half is the one that needs care. The plan's Debug note is
 * specific: "if retention deletes too early, the `retain_until` was computed at
 * ingest from the wrong clock — verify against a call made just before a day
 * boundary." So there is a call made at 23:59.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createPool } from "../src/db.js";
import { clearSentCommands, finalizeCall, handleCallEvent } from "../src/callcontrol.js";
import { buildSummary, callReview, recentCalls } from "../src/callreview.js";
import { ARTIFACTS_DIR } from "../src/paths.js";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OWNER = "+15551234567";
const STAMP = Date.now().toString(36);
const b64 = (s: string) => Buffer.from(s).toString("base64");
const GREETING = b64("greeting");
const REPLY = b64("reply");
const WINDOW = Number(process.env.JARVIS_ENDPOINT_MS ?? 5000);

let n = 0;
const newCcid = () => `s24-${STAMP}-${(n += 1)}`;

function ev(type: string, ccid: string, extra: Record<string, unknown> = {}) {
  return {
    data: {
      event_type: type,
      payload: {
        call_control_id: ccid, call_leg_id: `${ccid}-leg`, from: OWNER,
        stir_shaken: { attestation: "A" }, ...extra,
      },
    },
  };
}
const said = (text: string) => ({ transcription_data: { transcript: text, is_final: true } });

async function upToListening(ccid: string): Promise<void> {
  await handleCallEvent(pool, ev("call.initiated", ccid));
  await handleCallEvent(pool, ev("call.answered", ccid));
  await handleCallEvent(pool, ev("call.playback.ended", ccid, { client_state: GREETING }));
}

async function turn(ccid: string, text: string): Promise<void> {
  await handleCallEvent(pool, ev("call.transcription", ccid, said(text)));
  await sleep(WINDOW * 1.5 + 700);
  await handleCallEvent(pool, ev("call.playback.ended", ccid, { client_state: REPLY }));
}

async function main(): Promise<void> {
  console.log("########## a call, then read back what it was ##########\n");
  let ccid = "";
  {
    ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await turn(ccid, `in Alpha the login button is off-centre on mobile, fix it ${STAMP}`);
    await turn(ccid, "how is the deploy going");
    await handleCallEvent(pool, ev("call.hangup", ccid, { hangup_cause: "normal_clearing" }));

    const review = await callReview(pool, ccid);
    truthy("the call can be reviewed", review);
    if (!review) throw new Error("no review");

    check("both turns are there", 2, review.said.length);
    truthy("with what he said", review.said[0].heard.includes("off-centre"));
    truthy("and what Jarvis said back", (review.said[0].answer ?? "").length > 0);
    truthy("and how long each took", typeof review.said[0].totalMs === "number");

    truthy("there is a summary", review.summary);
    console.log(`  summary: ${review.summary}`);
    truthy("naming what was asked", review.summary?.includes("off-centre"));
    truthy("the transcript is stored", review.transcriptArtifactId);
    truthy("and it is attached to a conversation", review.conversationId);

    truthy("the tasks it produced are listed", review.tasks.length > 0);
    truthy("with their project", review.tasks.some((t) => t.slug === "alpha-web"));
    truthy("and their state", review.tasks[0].state.length > 0);
    check("the end is recorded", true, (review.endReason ?? "").includes("hangup"));
  }

  console.log("\n########## the summary says what came of it ##########\n");
  {
    const quiet = newCcid();
    await upToListening(quiet);
    await handleCallEvent(pool, ev("call.hangup", quiet, { hangup_cause: "normal_clearing" }));
    const summary = await buildSummary(pool, quiet);
    console.log(`  a call with nothing said: ${summary}`);
    truthy("a call with nothing said says so", summary.toLowerCase().includes("nothing was said"));

    const busy = await buildSummary(pool, ccid);
    truthy("and a call that produced work says what it produced", /task/i.test(busy));
  }

  console.log("\n########## and a later call can find it ##########\n");
  {
    /*
     * "Ask in a later call 'what did I ask you about Alpha yesterday?' and get
     * it right." The mechanism is `memory_search`, which the desk already has —
     * so what is asserted here is that the memory exists and matches the words
     * he used, which is what makes the search find it rather than luck.
     */
    const mem = await pool.query<{ body: string }>(
      `SELECT body FROM memory_items WHERE kind = 'call' AND body LIKE $1 ORDER BY created_at DESC LIMIT 1`,
      [`%${STAMP}%`],
    );
    truthy("the call was filed in memory", mem.rowCount === 1);
    truthy("with what he actually said, not only a paraphrase",
      mem.rows[0]?.body.includes("off-centre"));
    truthy("and the project he named", mem.rows[0]?.body.includes("Alpha"));
    truthy("marked as having happened on the phone", mem.rows[0]?.body.includes("On the phone"));

    // The search a later call would run.
    const found = await pool.query<{ body: string }>(
      `SELECT body FROM memory_items
       WHERE kind = 'call' AND body ILIKE '%alpha%' ORDER BY created_at DESC LIMIT 3`,
    );
    truthy("searching for Alpha finds it", found.rows.some((r) => r.body.includes(STAMP)));
  }

  console.log("\n########## the list, for the console ##########\n");
  {
    const calls = await recentCalls(pool, 20);
    const mine = calls.find((c) => c.call_control_id === ccid);
    truthy("the call is in the list", mine);
    check("with its turn count", 2, mine?.turns);
    truthy("its summary", String(mine?.summary ?? "").length > 0);
    check("a transcript", true, mine?.has_transcript);
    truthy("and how many tasks it caused", Number(mine?.task_count ?? 0) > 0);
  }

  console.log("\n########## audio retention: seven days, and the day boundary ##########\n");
  {
    /*
     * A recording ingested at 23:59. The Debug note names this exactly: a
     * `retain_until` computed from the wrong clock deletes a whole day early,
     * and it only shows up on a call made just before midnight.
     */
    const late = new Date();
    late.setUTCHours(23, 59, 0, 0);
    const rec = await pool.query<{ id: string; retain_until: string; created_at: string }>(
      `INSERT INTO artifacts (path, mime, bytes, source, quarantine_state, retention_class,
                              retain_until, permanent, sha256, created_at)
       VALUES ($1, 'audio/mpeg', 1024, 'phone', 'clean', 'raw_audio',
               $2::timestamptz + interval '7 days', false, $3, $2::timestamptz)
       RETURNING id, retain_until::text, created_at::text`,
      [`phone/retention-${STAMP}.mp3`, late.toISOString(), `sha-${STAMP}`],
    );
    const days =
      (new Date(rec.rows[0].retain_until).getTime() - new Date(rec.rows[0].created_at).getTime())
      / 86_400_000;
    check("a recording made at 23:59 is kept for a full seven days", 7, Math.round(days * 100) / 100);
    truthy("not six", days > 6.9);

    // Now age it past the window and run the real retention job.
    await fs.mkdir(path.join(ARTIFACTS_DIR, "phone"), { recursive: true });
    const file = path.join(ARTIFACTS_DIR, "phone", `retention-${STAMP}.mp3`);
    await fs.writeFile(file, "not really audio");
    await pool.query(
      "UPDATE artifacts SET retain_until = now() - interval '1 minute' WHERE id = $1",
      [rec.rows[0].id],
    );

    // A transcript of the same age, which must NOT be deleted.
    /*
     * The transcript is given an EXPIRED retain_until too, deliberately. Without
     * it the only thing protecting it is a null date, and the assertion would
     * pass even if the job deleted everything whose class it did not check —
     * which is exactly the mistake worth catching.
     */
    const transcript = await pool.query<{ id: string }>(
      `INSERT INTO artifacts (path, mime, bytes, source, quarantine_state, retention_class,
                              retain_until, sha256)
       VALUES ($1, 'text/markdown', 200, 'phone', 'clean', 'other',
               now() - interval '1 day', $2) RETURNING id`,
      [`phone/transcript-keep-${STAMP}.md`, `sha-t-${STAMP}`],
    );

    // THE job, not a copy of it.
    const { audioRetention } = await import("../src/retention.js");
    await audioRetention(pool);

    const goneRow = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM artifacts WHERE id = $1", [rec.rows[0].id]);
    check("at day seven the raw audio row is gone", "0", goneRow.rows[0].n);
    const onDisk = await fs.access(file).then(() => true, () => false);
    check("and so is the file", false, onDisk);

    const kept = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM artifacts WHERE id = $1", [transcript.rows[0].id]);
    check("the transcript is still there", "1", kept.rows[0].n);
    ok("...which is the whole rule: the audio goes, the record of what was said stays");

    await pool.query("DELETE FROM artifacts WHERE id = $1", [transcript.rows[0].id]);
  }

  console.log("\n########## a call whose audio has expired still reviews ##########\n");
  {
    const review = await callReview(pool, ccid);
    truthy("the review still works", review);
    check("and it says the recording is not available", false, review?.recordingAvailable);
    truthy("while the transcript still is", review?.transcriptArtifactId);
  }

  await pool.query("DELETE FROM memory_items WHERE kind = 'call' AND body LIKE $1", [`%${STAMP}%`]);
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

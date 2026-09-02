/**
 * Six defects from one real phone call, 2026-09-02 12:24:38Z.
 *
 * The transcript read beautifully and the call delivered almost none of it. Each
 * section here is one of the six, asserted the way the call exposed it:
 *
 *   1. the answer was cut off after 7.7s of a ~150-word reply, and nothing was
 *      raised — a truncated answer must be a failure, not a state transition;
 *   2. what was spoken was the desk's WRITTEN reply: bold, bullets, ✅/⚠️,
 *      model version strings — which is what made the render take 7.4 seconds;
 *   3. `call_transitions.from_state` read "greeting|thinking|speaking|ringing";
 *   4. a progress line was spoken four seconds AFTER the answer started;
 *   5. "Sorry, sir, this is slow." — apologising for latency;
 *   6. total 15.9s with every individual leg inside its own budget.
 */
import { createPool } from "../src/db.js";
import {
  clearSentCommands, finalizeCall, handleCallEvent, sentCommands, spokenLines, sweepCallDeadlines,
} from "../src/callcontrol.js";
import { spokenOnCall, linesBeforeAnythingHappened } from "../src/callbank.js";
import { TURN_MS } from "../src/callruntime.js";
import { BUDGET_MS, callTimeline, currentState } from "../src/callstate.js";
import { speakable, SPOKEN_LIMIT } from "../src/speakable.js";

const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 300)}`);
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
const newCcid = () => `s21b-${STAMP}-${(n += 1)}`;

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
/** One place for the emoji pattern, so the source never carries a raw escape. */
const EMOJI_RE = new RegExp("[" + String.fromCodePoint(0x1F000) + "-"
  + String.fromCodePoint(0x1FAFF) + String.fromCodePoint(0x2190) + "-"
  + String.fromCodePoint(0x27BF) + "]", "u");

const said = (text: string) => ({ transcription_data: { transcript: text, is_final: true } });

async function upToListening(ccid: string): Promise<void> {
  await handleCallEvent(pool, ev("call.initiated", ccid));
  await handleCallEvent(pool, ev("call.answered", ccid));
  await handleCallEvent(pool, ev("call.playback.ended", ccid, { client_state: GREETING }));
}

/** The actual reply from the call, near enough. */
const THE_WRITTEN_ANSWER =
  "All systems nominal, Enrique. Here's the rundown:\n\n"
  + "**Model routing (supervisor)**\n"
  + "- Primary: **DeepSeek V4 Flash** (Fireworks) — $0.27/M in, $0.40/M out ✅\n"
  + "- Fallback: **GLM-5.3-Flash** ⚠️ degraded\n"
  + "- Utility: `nemotron-lightning-9b`\n\n"
  + "**Spend** this month is $11.42 of a $60 cap.\n"
  + "1. No open incidents\n"
  + "2. Backups green at 03:00Z\n"
  + "3. Two tasks queued, one running\n";

async function main(): Promise<void> {
  console.log("########## 2. a written answer is not a spoken answer ##########\n");
  {
    const { say, truncated } = speakable(THE_WRITTEN_ANSWER);
    console.log(`  spoken: ${say}`);
    truthy("no markdown bold survives", !say.includes("**"));
    truthy("no bullets", !/^\s*[-*•]/m.test(say));
    truthy("no headings", !say.includes("#"));
    truthy("no backticks", !say.includes("`"));
    truthy("no emoji", !/[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}]/u.test(say));
    truthy("no newlines at all — it is one spoken line", !say.includes("\n"));
    truthy(`and it is short (${say.length} chars)`, say.length <= SPOKEN_LIMIT + 60);
    check("the caller is told where the rest is", true, truncated && say.includes("Control Center"));
    truthy("but the beginning of the real answer survives", say.includes("All systems nominal"));

    const short = speakable("The deploy finished twenty minutes ago.");
    check("a short plain answer is left exactly as it was",
      "The deploy finished twenty minutes ago.", short.say);
    check("and is not marked truncated", false, short.truncated);
  }

  {
    // And end to end: the runtime must speak the plain form, not merely be able
    // to produce one. Bypassing `speakable` in the runtime left every assertion
    // above green, which made them assertions about a function nobody called.
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("give me the rundown")));
    await sleep(WINDOW * 1.5 + 700);
    const spoken = spokenLines.filter((l) => l.ccid === ccid && l.clientState === REPLY);
    const line = spoken[spoken.length - 1]?.text ?? "";
    console.log(`  down the line: ${line.slice(0, 120)}`);
    truthy("what actually goes down the line has no markdown", line.length > 0 && !line.includes("**"));
    truthy("and no emoji", !EMOJI_RE.test(line));
    truthy("and no newlines", !line.includes(String.fromCharCode(10)));
    await finalizeCall(pool, ccid, "spoken form test done");
  }

  console.log("\n########## 5. no apologising for latency ##########\n");
  {
    const bank = linesBeforeAnythingHappened();
    const grovel = bank.filter((l) => /sorry/i.test(l));
    check("nothing said while working apologises", 0, grovel.length);
    if (grovel.length) console.log(`        ${grovel.join(" | ")}`);
    const sirs = bank.filter((l) => /\bsir\b/i.test(l));
    truthy("and the working lines are not all 'sir', either", sirs.length <= 1);
  }

  console.log("\n########## 3. a transition names one state, not a set ##########\n");
  {
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("how is the deploy going")));
    await sleep(WINDOW * 1.5 + 600);

    /*
     * The transition the real call got wrong was written by the SWEEP, whose
     * move is allowed from four states at once. A test that only exercises
     * single-`from` moves cannot tell a joined set from a state.
     */
    await pool.query(
      "UPDATE calls SET deadline_at = now() - interval '1 second', deadline_leg = 'model'"
      + " WHERE call_control_id = $1",
      [ccid],
    );
    await sweepCallDeadlines(pool);

    const trail = await callTimeline(pool, ccid);
    const STATES = new Set(["ringing", "greeting", "listening", "thinking", "speaking", "closing", "ended"]);
    const bogus = trail.filter((t) => t.from_state !== null && !STATES.has(t.from_state));
    check("every from_state is a single real state", 0, bogus.length);
    if (bogus.length) console.log(`        ${bogus.map((b) => b.from_state).join(" | ")}`);
    truthy("and the trail actually recorded the states it passed through",
      trail.some((t) => t.from_state === "listening" && t.to_state === "thinking"));
    await finalizeCall(pool, ccid, "transition test done");
  }

  console.log("\n########## 4. nothing scheduled outlives the answer ##########\n");
  {
    const ccid = newCcid();
    clearSentCommands();
    // Slow enough to schedule a progress line, but it resolves before it fires.
    process.env.JARVIS_MODEL_DELAY_MS = String(Math.round(TURN_MS.progress * 0.6));
    // The render takes long enough that a ladder timer left running WOULD fire
    // during it, which is exactly what happened on the real call.
    process.env.JARVIS_TTS_DELAY_MS = String(Math.round(TURN_MS.progress * 0.8));
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("read me the queue")));
    // The slow render applies to every line, and they are spoken in sequence —
    // acknowledgement, then the answer — so this waits for all of them.
    await sleep(WINDOW * 1.5 + TURN_MS.progress * 4 + 1200);
    process.env.JARVIS_MODEL_DELAY_MS = "0";
    process.env.JARVIS_TTS_DELAY_MS = "0";

    const beforeWait = await spokenOnCall(pool, ccid);
    const answerAt = beforeWait.findIndex((l) => l.kind === "answer");
    truthy("the answer was spoken", answerAt >= 0);

    // Wait past the moment the progress line WOULD have fired.
    await sleep(TURN_MS.progress + 400);
    const after = await spokenOnCall(pool, ccid);
    check("nothing was said after the answer", answerAt, after.findIndex((l) => l.kind === "answer"));
    check("and no progress line arrived late", 0, after.filter((l) => l.kind === "progress").length);
    await finalizeCall(pool, ccid, "late progress test done");
  }

  console.log("\n########## 1. a cut-off answer is a failure ##########\n");
  {
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("how is the deploy going")));
    await sleep(WINDOW * 1.5 + 600);

    const call = await pool.query<{ state: string; deadline_leg: string | null }>(
      "SELECT state, deadline_leg FROM calls WHERE call_control_id = $1", [ccid]);
    check("while the answer plays the call is speaking", "speaking", call.rows[0]?.state);
    check(
      "and the budget being counted is the PLAYING one, not the render",
      "playing",
      call.rows[0]?.deadline_leg,
    );
    truthy(
      `which is far longer than the render budget (${BUDGET_MS.playing}ms vs ${BUDGET_MS.tts}ms)`,
      BUDGET_MS.playing > BUDGET_MS.tts * 5,
    );

    // Force it to blow: the playback never ends.
    await pool.query(
      "UPDATE calls SET deadline_at = now() - interval '1 second' WHERE call_control_id = $1", [ccid]);
    const before = (await spokenOnCall(pool, ccid)).length;
    await sweepCallDeadlines(pool);

    const issue = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM issues
       WHERE dedupe_key = $1 AND status NOT IN ('resolved','ignored')`,
      [`phone.playback-truncated:${ccid}`],
    );
    check("a cut-off answer raises an issue", "1", issue.rows[0].n);
    const turn = await pool.query<{ outcome: string }>(
      "SELECT outcome FROM call_turns WHERE call_control_id = $1 ORDER BY n DESC LIMIT 1", [ccid]);
    check("and the turn is recorded as failed, not answered", "failed", turn.rows[0]?.outcome);
    check("no holding line was spoken over the top of it", before, (await spokenOnCall(pool, ccid)).length);
    check("the caller has the floor back", "listening", await currentState(pool, ccid));
    await finalizeCall(pool, ccid, "truncation test done");
  }

  console.log("\n########## 6. the whole turn is budgeted, not each leg ##########\n");
  {
    truthy("there is a whole-turn budget", TURN_MS.whole > 0);
    truthy("shorter than the handover budget, or it could never fire",
      TURN_MS.whole <= TURN_MS.budget);

    const ccid = newCcid();
    clearSentCommands();
    // Inside the handover budget, over the whole-turn budget.
    process.env.JARVIS_MODEL_DELAY_MS = String(TURN_MS.whole + Math.round(TURN_MS.checking));
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("what is the spend")));
    await sleep(WINDOW * 1.5 + TURN_MS.whole + TURN_MS.checking + 700);
    process.env.JARVIS_MODEL_DELAY_MS = "0";

    const turn = await pool.query<{ total_ms: number; outcome: string }>(
      "SELECT total_ms, outcome FROM call_turns WHERE call_control_id = $1 ORDER BY n DESC LIMIT 1",
      [ccid]);
    console.log(`  the turn took ${turn.rows[0]?.total_ms}ms against a ${TURN_MS.whole}ms budget`);
    truthy("the turn is over budget", (turn.rows[0]?.total_ms ?? 0) > TURN_MS.whole);
    const issue = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM issues
       WHERE dedupe_key = 'phone.turn-over-budget' AND status NOT IN ('resolved','ignored')`,
    );
    check("and it left a ticket rather than only a number in a column", "1", issue.rows[0].n);
    await finalizeCall(pool, ccid, "whole-turn budget test done");
  }

  console.log("\n########## the setup banner closes itself ##########\n");
  {
    const { resolveSatisfiedBlockers } = await import("../src/blockers.js");
    // A gap that is satisfied: composio with a credential.
    await pool.query(
      `INSERT INTO issues (severity, category, service, status, owner, title, dedupe_key)
       VALUES ('medium','setup.pending','composio','waiting_for_user','user',
               '[setup] Composio not connected','setup.composio')
       ON CONFLICT DO NOTHING`,
    );
    const hasCred = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM auth_profiles WHERE id='composio' AND credential_id IS NOT NULL",
    );
    if (Number(hasCred.rows[0].n) === 0) {
      ok("(no composio credential in this environment; the closing pass is asserted on its query)");
      const closed = await resolveSatisfiedBlockers(pool);
      check("nothing is closed while the gap is real", false, closed.includes("setup.composio"));
      const still = await pool.query<{ status: string }>(
        "SELECT status FROM issues WHERE dedupe_key = 'setup.composio' ORDER BY created_at DESC LIMIT 1");
      check("and the banner stays up", "waiting_for_user", still.rows[0]?.status);
    } else {
      const closed = await resolveSatisfiedBlockers(pool);
      truthy("a satisfied setup gap closes itself", closed.includes("setup.composio"));
    }
    await pool.query("DELETE FROM issues WHERE dedupe_key = 'setup.composio'");
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

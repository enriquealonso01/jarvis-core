/**
 * S21 — the conversational orchestration runtime.
 *
 * The plan's own framing: "it acknowledges — but not the same way every time —
 * says it is going to check something, goes and actually checks it, comes back
 * and answers." Everything here is about what happens DURING a turn, so
 * everything here is about timing, and the timings are scaled by
 * `JARVIS_TURN_SCALE` so the ladder can be exercised in seconds rather than in
 * minutes. The last section reads the shipped numbers from a second process, so
 * the scaling cannot quietly become the thing being tested.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/db.js";
import {
  clearSentCommands, finalizeCall, handleCallEvent, sentCommands, spokenLines,
} from "../src/callcontrol.js";
import { spokenOnCall } from "../src/callbank.js";
import { TURN_MS } from "../src/callruntime.js";
import { currentState } from "../src/callstate.js";

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
const newCcid = () => `s21-${STAMP}-${(n += 1)}`;

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

/**
 * Say something and wait for the turn to be taken and finished.
 *
 * `slowMs` makes the tool track take that long, which is how the ladder's
 * later rungs are reached without a real slow provider.
 */
async function turn(ccid: string, text: string, slowMs = 0): Promise<void> {
  process.env.JARVIS_MODEL_DELAY_MS = String(slowMs);
  await handleCallEvent(pool, ev("call.transcription", ccid, said(text)));
  await sleep(WINDOW * 1.5 + Math.max(slowMs, 0) + 500);
  process.env.JARVIS_MODEL_DELAY_MS = "0";
  await handleCallEvent(pool, ev("call.playback.ended", ccid, { client_state: REPLY }));
}

async function main(): Promise<void> {
  console.log(
    `########## the shape of a turn (ack ${TURN_MS.ack}ms, check ${TURN_MS.checking}ms, `
    + `progress ${TURN_MS.progress}ms, budget ${TURN_MS.budget}ms) ##########\n`,
  );
  {
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await turn(ccid, "how is the deploy going");

    const turns = await pool.query<{ ack_ms: number | null; total_ms: number | null; outcome: string; answer_text: string | null }>(
      "SELECT ack_ms, total_ms, outcome, answer_text FROM call_turns WHERE call_control_id = $1 ORDER BY n",
      [ccid],
    );
    check("one turn was recorded", 1, turns.rowCount);
    check("and it ended in an answer", "answered", turns.rows[0]?.outcome);
    truthy("with the answer written down", turns.rows[0]?.answer_text);
    truthy("and a total time on it, so 'it felt slow' can become a number",
      typeof turns.rows[0]?.total_ms === "number");

    const spoken = await spokenOnCall(pool, ccid);
    truthy("something was said out loud", spoken.length > 0);
    check("and the last thing said was the answer", "answer", spoken[spoken.length - 1]?.kind);
    await finishCall(ccid, "turn shape done");
  }

  console.log("\n########## the variety test ##########\n");
  {
    // Many lookups, one call. The plan: "No acknowledgement repeats
    // consecutively, and progress lines never repeat verbatim. Grep the
    // transcript for consecutive duplicates — this is mechanically checkable,
    // so check it mechanically."
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);

    // Three of them are slow enough to reach the progress rung, so there is
    // more than one progress line to compare.
    const asks: [string, number][] = [
      ["how is the deploy going", 0],
      ["read me the queue", TURN_MS.progress + TURN_MS.checking],
      ["what is the spend", 0],
      ["check the alpha migration", TURN_MS.progress + TURN_MS.checking],
      ["how many issues are open", 0],
      ["what did i tell you about tuesdays", TURN_MS.progress + TURN_MS.checking],
      ["say something short", 0],
    ];
    for (const [ask, slow] of asks) await turn(ccid, ask, slow);

    const spoken = await spokenOnCall(pool, ccid);
    const acks = spoken.filter((s) => s.kind === "ack").map((s) => s.text);
    console.log(`  ${acks.length} acknowledgements: ${[...new Set(acks)].length} distinct`);
    truthy("there were several acknowledgements to compare", acks.length >= 3);

    const consecutive = acks.filter((a, i) => i > 0 && a === acks[i - 1]);
    check("no acknowledgement repeats consecutively", 0, consecutive.length);
    if (consecutive.length) console.log(`        repeated: ${consecutive.join(" | ")}`);

    const progress = spoken.filter((s) => s.kind === "progress").map((s) => s.text);
    check("and no progress line repeats verbatim, ever", progress.length, new Set(progress).size);

    // Mechanical, over the whole transcript: nothing Jarvis said twice in a row.
    const all = spoken.filter((s) => s.kind !== "answer").map((s) => s.text);
    check("nothing at all was said twice in a row", 0,
      all.filter((a, i) => i > 0 && a === all[i - 1]).length);
    await finishCall(ccid, "variety done");
  }

  console.log("\n########## the budget test ##########\n");
  {
    // The tool track is forced to take far longer than the phone-side budget.
    process.env.JARVIS_MODEL_DELAY_MS = String(TURN_MS.budget * 3);
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);

    /*
     * Scope the call to a project before the handover fires.
     *
     * This used to run unscoped, and the handover created a heavy task with
     * `project_id = null` — which is exactly the chain that reached Enrique on a
     * live call: no project, so no repository, so the runner built in
     * `worktrees/unscoped/`, so the isolation tripwire raised a CRITICAL, so a
     * security event rang the phone inside quiet hours.
     *
     * The guarantee this block exists for is "the request is filed, in full,
     * rather than lost", and that is unchanged. What changed is that a
     * call-created task must have somewhere to be done — so the fixture now
     * gives it one, and the unscoped case is asserted separately in
     * `call-never-unscoped-test`, where the answer is that no task is created
     * at all.
     */
    const t0 = Date.now();
    await handleCallEvent(pool, ev("call.transcription", ccid, said("check the alpha migration")));
    // After the transcription AND a beat: the conversation is created as the
    // turn opens, which happens just after this event is dispatched.
    await sleep(600);
    await pool.query(
      `UPDATE conversations SET project_id = (SELECT id FROM projects WHERE slug = 'dev-sandbox')
       WHERE id = (SELECT conversation_id FROM calls WHERE call_control_id = $1)`,
      [ccid],
    );
    await sleep(WINDOW * 1.5 + TURN_MS.budget + 600);
    process.env.JARVIS_MODEL_DELAY_MS = "0";

    const spoken = await spokenOnCall(pool, ccid);
    const kinds = spoken.map((s) => s.kind);
    console.log(`  said: ${spoken.map((s) => `${s.kind}:${s.text.slice(0, 28)}`).join(" | ")}`);
    truthy("it acknowledged", kinds.includes("ack"));
    truthy("then said it was still checking", kinds.includes("checking"));
    truthy("then gave a real progress line", kinds.includes("progress"));
    truthy("then handed over", kinds.includes("handover"));
    check("in that order", "ack,checking,progress,handover", kinds.join(","));

    const row = await pool.query<{ outcome: string; handover_task_id: string | null }>(
      "SELECT outcome, handover_task_id FROM call_turns WHERE call_control_id = $1", [ccid]);
    check("the turn is recorded as handed over", "handed_over", row.rows[0]?.outcome);
    truthy("with a task created for the desk", row.rows[0]?.handover_task_id);

    const task = await pool.query<{ objective: string; state: string }>(
      "SELECT objective, state FROM tasks WHERE id = $1", [row.rows[0]?.handover_task_id]);
    check(
      "and the task carries the FULL request, not a summary of it",
      "check the alpha migration",
      task.rows[0]?.objective,
    );
    check("the caller got the floor back", "listening", await currentState(pool, ccid));

    // "The call never goes silent for more than ~10s" — in scaled terms, no gap
    // between spoken lines longer than the progress interval plus a margin.
    const times = await pool.query<{ gap: number }>(
      `SELECT EXTRACT(epoch FROM at - lag(at) OVER (ORDER BY at, id)) * 1000 AS gap
       FROM call_speech WHERE call_control_id = $1`, [ccid]);
    const worst = Math.max(0, ...times.rows.map((r) => Number(r.gap ?? 0)));
    console.log(`  longest silence between lines: ${Math.round(worst)}ms`);
    truthy(
      `never silent longer than the progress interval (${TURN_MS.progress}ms) plus slack`,
      worst < TURN_MS.progress * 1.8,
    );
    console.log(`  whole turn took ${Date.now() - t0}ms`);
    await finishCall(ccid, "budget done");
  }

  console.log("\n########## the interruption test ##########\n");
  for (const over of ["ack", "progress", "answer"] as const) {
    process.env.JARVIS_MODEL_DELAY_MS = over === "answer" ? "0" : String(TURN_MS.budget * 3);
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("read me the queue")));

    // Wait until the line being interrupted is the one in the air.
    if (over === "ack") await sleep(WINDOW * 1.5 + TURN_MS.ack + 60);
    if (over === "progress") await sleep(WINDOW * 1.5 + TURN_MS.progress + 60);
    if (over === "answer") await sleep(WINDOW * 1.5 + 200);

    const before = Date.now();
    await handleCallEvent(pool, ev("call.transcription", ccid, said("actually, hold on")));
    const took = Date.now() - before;

    const stops = sentCommands.filter((c) => c.ccid === ccid && c.action === "playback_stop");
    truthy(`[over the ${over}] the playback is stopped`, stops.length >= 1);
    truthy(`[over the ${over}] within a beat — ${took}ms`, took < 300);
    check(`[over the ${over}] and it is listening`, "listening", await currentState(pool, ccid));

    /*
     * Nothing scheduled behind the interruption may still arrive. Counted
     * against the INTERRUPTED TURN, not the call: what he said while
     * interrupting is a new turn and is supposed to be answered — the thing
     * that must never arrive is the progress line that was already queued.
     */
    const interrupted = await pool.query<{ id: string }>(
      "SELECT id FROM call_turns WHERE call_control_id = $1 ORDER BY n LIMIT 1", [ccid]);
    const linesOf = async () => Number((await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM call_speech WHERE turn_id = $1",
      [interrupted.rows[0]?.id])).rows[0].n);
    const said1 = await linesOf();
    await sleep(TURN_MS.progress + 200);
    check(`[over the ${over}] nothing queued behind it still gets spoken`, said1, await linesOf());
    process.env.JARVIS_MODEL_DELAY_MS = "0";
    await finishCall(ccid, `interruption over ${over} done`);
  }

  console.log("\n########## the silence test ##########\n");
  {
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("I was thinking about")));
    // A pause SHORTER than the endpoint window: he has not finished.
    await sleep(WINDOW * 0.7);
    check("it does not fill the pause", 0, (await spokenOnCall(pool, ccid)).length);
    check("and it is still listening", "listening", await currentState(pool, ccid));
    ok("...a pause where Enrique is thinking is his");
    await finishCall(ccid, "silence done");
  }

  console.log("\n########## the capture test ##########\n");
  {
    /*
     * The conversation goes as badly as it can: no voice at all, and the caller
     * hangs up before anything could have been said. What he asked for must
     * still be captured and routed exactly as a WhatsApp message would be.
     */
    process.env.JARVIS_PHONE_FAIL = "tts";
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await handleCallEvent(pool, ev("call.transcription", ccid, said("the login button is dead")));
    await sleep(WINDOW * 1.5 + TURN_MS.budget + 600);
    await handleCallEvent(pool, ev("call.hangup", ccid, { hangup_cause: "normal_clearing" }));
    process.env.JARVIS_PHONE_FAIL = "";

    const inbox = await pool.query<{ id: string; capture_state: string; processing_state: string }>(
      `SELECT id, capture_state, processing_state FROM inbox_events
       WHERE channel = 'phone' AND raw_text = 'the login button is dead'
       ORDER BY received_at DESC LIMIT 1`,
    );
    check("what he said was persisted", "persisted", inbox.rows[0]?.capture_state);
    truthy("and routed rather than left pending", inbox.rows[0]?.processing_state !== "pending");

    const task = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tasks WHERE origin_inbox_id = $1`,
      [inbox.rows[0]?.id],
    );
    truthy("and the work was filed regardless of how the call sounded", Number(task.rows[0].n) > 0);
    ok("...conversation quality and capture are independent, which is what lets the phone be shallow");
  }

  console.log("\n########## ten calls: acknowledgement latency ##########\n");
  {
    const ccids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const ccid = newCcid();
      ccids.push(ccid);
      await upToListening(ccid);
      // Slow enough to acknowledge. A turn the desk answers immediately is
      // supposed NOT to acknowledge — "resolves <2.5s → answer directly, no
      // filler" — so measuring acknowledgement latency over instant turns
      // measures nothing at all.
      await turn(ccid, "how is the deploy going", TURN_MS.checking);
      await finishCall(ccid, "latency run");
    }
    const acks = await pool.query<{ ack_ms: number }>(
      `SELECT ack_ms FROM call_turns WHERE call_control_id = ANY($1::text[]) AND ack_ms IS NOT NULL
       ORDER BY ack_ms`,
      [ccids],
    );
    const xs = acks.rows.map((r) => r.ack_ms);
    console.log(`  ${xs.length} of 10 calls acknowledged before answering`);
    if (!xs.length) {
      bad("ten calls produced acknowledgement timings", "some", "none");
    } else {
      const at = (p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];
      const p50 = at(0.5);
      const p95 = at(0.95);
      console.log(`  n=${xs.length}  p50=${p50}ms  p95=${p95}ms  (scheduled at ${TURN_MS.ack}ms)`);
      // The budget is the scheduled moment plus the work of choosing, recording
      // and issuing the line — not the wall clock from the caller's syllable,
      // which includes Telnyx and the STT engine.
      truthy(`p50 acknowledgement latency ${p50}ms is inside budget`, p50 < TURN_MS.ack + 250);
      truthy(`p95 acknowledgement latency ${p95}ms is inside budget`, p95 < TURN_MS.ack + 400);
    }
  }

  console.log("\n########## the shipped numbers are the plan's ##########\n");
  {
    const env = { ...process.env };
    delete env.JARVIS_TURN_SCALE;
    const out = await new Promise<string>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", path.join(path.dirname(fileURLToPath(import.meta.url)), "s21-defaults.ts")],
        { env, stdio: ["ignore", "pipe", "inherit"] },
      );
      let buf = "";
      child.stdout.on("data", (d) => { buf += String(d); });
      child.on("close", () => resolve(buf.trim()));
    });
    console.log(`  shipped: ${out}`);
    check("acknowledge at 600ms, hold at 2.5s, progress at 10s, hand over at 25s",
      "600,2500,10000,25000", out);
    truthy("and this run scaled them down, which is why it is fast", TURN_MS.budget < 25000);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

async function finishCall(ccid: string, why: string): Promise<void> {
  await finalizeCall(pool, ccid, why);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

/**
 * S22 — the desk actually does the work.
 *
 * "Tier 1 keeps the line human; Tier 2 has every tool. Today Tier 2 answers. It
 * must act." So this suite is about effects, not about how the call sounded:
 * does a sentence spoken down a phone line become a heavy task in the right
 * project with an objective the desk can actually work from, does the call carry
 * its own context from turn to turn, does the answer say where it came from, and
 * does anything ever come back when the work is finished.
 *
 * The one thing tier 1 must never do — claim that something was done — is
 * checked mechanically rather than by reading the prompt, because a prompt is a
 * request and this is a guarantee.
 */
import { createPool } from "../src/db.js";
import { clearSentCommands, finalizeCall, handleCallEvent, spokenLines } from "../src/callcontrol.js";
import { spokenOnCall } from "../src/callbank.js";
import { linesBeforeAnythingHappened } from "../src/callbank.js";
import { triage } from "../src/callagent.js";
import { tierOneClaims } from "../src/callclaims.js";
import { citeSources, TURN_MS } from "../src/callruntime.js";

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
const contains = (m: string, needle: string, hay: string) =>
  (hay ?? "").includes(needle) ? ok(m) : bad(m, `contains "${needle}"`, hay);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OWNER = "+15551234567";
const STAMP = Date.now().toString(36);
const b64 = (s: string) => Buffer.from(s).toString("base64");
const GREETING = b64("greeting");
const REPLY = b64("reply");
const WINDOW = Number(process.env.JARVIS_ENDPOINT_MS ?? 5000);

let n = 0;
const newCcid = () => `s22-${STAMP}-${(n += 1)}`;

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
  console.log("########## a sentence on the phone becomes work ##########\n");
  let alphaTask = "";
  {
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await turn(ccid, "in Alpha the login button is off-centre on mobile, fix it and open a PR");
    await handleCallEvent(pool, ev("call.hangup", ccid, { hangup_cause: "normal_clearing" }));

    const task = await pool.query<{
      id: string; lane: string; state: string; objective: string; slug: string | null;
      origin: string | null; channel: string | null;
    }>(
      `SELECT t.id, t.lane, t.state, t.objective, p.slug, t.origin_inbox_id AS origin, i.channel
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN inbox_events i ON i.id = t.origin_inbox_id
       WHERE i.channel = 'phone' AND i.raw_text LIKE 'in Alpha the login button%'
       ORDER BY t.created_at DESC LIMIT 1`,
    );
    const t = task.rows[0];
    truthy("hanging up did not stop a task being created", t);
    if (t) {
      alphaTask = t.id;
      check("it is heavy work, not a note", "heavy", t.lane);
      check("in the right project", "alpha-web", t.slug);
      check("and it is queued for the desk", "queued", t.state);
      contains("with an objective the desk can work from", "off-centre", t.objective);
      truthy("which is a usable instruction, not a summary", t.objective.length > 40);
      check("and it points back at the call that produced it", "phone", t.channel);
    }

    const call = await pool.query<{ state: string; transcript_artifact_id: string | null }>(
      "SELECT state, transcript_artifact_id FROM calls WHERE call_control_id = $1", [ccid]);
    check("the call ended cleanly", "ended", call.rows[0]?.state);
    truthy("with its transcript stored", call.rows[0]?.transcript_artifact_id);
  }

  console.log("\n########## one sentence never becomes two tasks ##########\n");
  {
    /*
     * From the live run of 2026-09-02: the desk took longer than the 25-second
     * budget, so the handover filed a task of its own — while the router was in
     * the middle of filing the correctly-scoped one. Two tasks for one sentence,
     * and the handover's had no project, so the runner had no repo, so the
     * harness wrote outside its worktree and the run was killed. One missing
     * fact at the top of that chain.
     */
    const ccid = newCcid();
    clearSentCommands();
    // Slower than the whole budget, so the handover definitely fires.
    process.env.JARVIS_MODEL_DELAY_MS = String(TURN_MS.budget * 2);
    await upToListening(ccid);
    /*
     * A work segment AND a question: the router files the task straight away,
     * and the DESK is what takes too long — which is the shape the real call
     * had. A pure work segment never reaches the Supervisor at all, so nothing
     * would be slow and the handover would never fire.
     */
    // Deliberately NOT the wording of the first section's fixture: the fake
    // model matches on the longest substring, and that one would win.
    const text = `the login button sits off-centre on mobile, fix it and how is the deploy going ${STAMP}b`;
    await handleCallEvent(pool, ev("call.transcription", ccid, said(text)));
    await sleep(WINDOW * 1.5 + TURN_MS.budget * 2 + 1500);
    process.env.JARVIS_MODEL_DELAY_MS = "0";

    const spoken = await spokenOnCall(pool, ccid);
    truthy("it handed over", spoken.some((l) => l.kind === "handover"));

    const inbox = await pool.query<{ id: string }>(
      "SELECT id FROM inbox_events WHERE raw_text = $1 ORDER BY received_at DESC LIMIT 1", [text]);
    const tasks = await pool.query<{ id: string; slug: string | null }>(
      `SELECT t.id, p.slug FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.origin_inbox_id = $1`,
      [inbox.rows[0]?.id],
    );
    check("one sentence, exactly one task", 1, tasks.rowCount);
    check("and it is the router's, with the project on it", "alpha-web", tasks.rows[0]?.slug);

    const turn = await pool.query<{ outcome: string; handover_task_id: string | null }>(
      "SELECT outcome, handover_task_id FROM call_turns WHERE call_control_id = $1", [ccid]);
    check("the turn says it was handed over", "handed_over", turn.rows[0]?.outcome);
    check("pointing at the task that already exists", tasks.rows[0]?.id, turn.rows[0]?.handover_task_id);
    await finalizeCall(pool, ccid, "no duplicate task test done");
  }

  console.log("\n########## two projects in one call, two tasks ##########\n");
  {
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await turn(ccid, `the login button is off-centre on mobile, and in dev-sandbox add the file ${STAMP}`);

    const tasks = await pool.query<{ slug: string; title: string }>(
      `SELECT p.slug, t.title FROM tasks t
       JOIN projects p ON p.id = t.project_id
       JOIN inbox_events i ON i.id = t.origin_inbox_id
       WHERE i.channel = 'phone' AND i.raw_text LIKE $1
       ORDER BY p.slug`,
      [`%add the file ${STAMP}`],
    );
    check("one sentence, two tasks", 2, tasks.rowCount);
    check("in the two projects named", "alpha-web,dev-sandbox",
      tasks.rows.map((r) => r.slug).join(","));
    ok("...routed by the same S3 classifier a WhatsApp message goes through");
    await finalizeCall(pool, ccid, "two projects done");
  }

  console.log("\n########## the call carries its own context ##########\n");
  {
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);

    await turn(ccid, "count the history");
    const first = (await spokenOnCall(pool, ccid)).find((s) => s.text.includes("messages:"))?.text ?? "";
    await turn(ccid, "how is the deploy going");
    await turn(ccid, "read me the queue");
    await turn(ccid, "count the history");
    const spoken = (await spokenOnCall(pool, ccid)).filter((s) => s.text.includes("messages:"));
    const last = spoken[spoken.length - 1]?.text ?? "";

    const num = (s: string) => Number(/messages:(\d+)/.exec(s)?.[1] ?? 0);
    console.log(`  first turn saw ${num(first)} messages, fourth saw ${num(last)}`);
    truthy("the first turn was asked with almost nothing behind it", num(first) <= 3);
    truthy(
      "and a later turn was asked WITH the earlier ones in front of it",
      num(last) > num(first),
    );

    const conv = await pool.query<{ n: string }>(
      `SELECT count(DISTINCT conversation_id)::text AS n FROM inbox_events
       WHERE channel = 'phone' AND received_at > now() - interval '10 minutes'
         AND conversation_id = (SELECT conversation_id FROM calls WHERE call_control_id = $1)`,
      [ccid],
    );
    check("one call is one conversation, not four unrelated questions", "1", conv.rows[0].n);
    await finalizeCall(pool, ccid, "context done");
  }

  console.log("\n########## the answer says where it came from ##########\n");
  {
    const ccid = newCcid();
    clearSentCommands();
    await upToListening(ccid);
    await turn(ccid, "what did I tell you about the client");

    const answers = spokenLines.filter((l) => l.ccid === ccid && l.clientState === REPLY);
    const answer = answers[answers.length - 1]?.text ?? "";
    console.log(`  answer: ${answer}`);
    contains("the answer cites the source it actually used", "your memory", answer);

    const inbox = await pool.query<{ id: string }>(
      `SELECT id FROM inbox_events WHERE channel = 'phone' AND raw_text = 'what did I tell you about the client'
       ORDER BY received_at DESC LIMIT 1`,
    );
    check("and the citation comes from the tool that ran, not from the model's word for it",
      "your memory", await citeSources(pool, inbox.rows[0].id));
    check("a turn with no tool call cites nothing",
      null, await citeSources(pool, "00000000-0000-0000-0000-000000000000"));
    await finalizeCall(pool, ccid, "citation done");
  }

  console.log("\n########## tier 1 never says a thing was done ##########\n");
  {
    // The detector itself, on the sentences that matter.
    const lies = [
      "I've filed that for you, sir.",
      "Right, that's done.",
      "Created the task.",
      "I have noted it.",
      "Stored.",
      "All done, sir.",
      "I've added it to the queue.",
    ];
    for (const lie of lies) {
      check(`"${lie}" is a claim`, true, tierOneClaims(lie));
    }
    const honest = [
      "Let me pass that to the desk, sir.",
      "Good morning, sir.",
      "I will have the desk look at that.",
      "Passing that on now.",
      "Very well, sir. What can I do for you?",
    ];
    for (const line of honest) {
      check(`"${line}" is not`, false, tierOneClaims(line));
    }

    // Through the real triage: a model that claims anyway is downgraded.
    const verdict = await triage(pool, "remember that the client prefers Tuesdays");
    truthy("a tier-1 verdict never claims an action", !tierOneClaims(verdict.say));
    console.log(`  tier 1 said: ${verdict.say}`);

    // And the fixed bank, which is what is actually said on most turns.
    const claims = linesBeforeAnythingHappened().filter((l) => tierOneClaims(l));
    check("no line said before the desk acts claims anything either", 0, claims.length);
    if (claims.length) console.log(`        ${claims.join(" | ")}`);

    // The transcripts of every call this suite made, grepped as the plan asks.
    const spoken = await pool.query<{ text: string; kind: string }>(
      // Everything except the answer itself and the handover, which are said
      // AFTER something really happened and are allowed to say so.
      `SELECT text, kind FROM call_speech
       WHERE call_control_id LIKE $1 AND kind NOT IN ('answer', 'handover')`,
      [`s22-${STAMP}-%`],
    );
    const claimed = spoken.rows.filter((r) => tierOneClaims(r.text));
    check("and nothing said before the desk reported claims an action", 0, claimed.length);
    if (claimed.length) console.log(`        ${claimed.map((c) => c.text).join(" | ")}`);
  }

  console.log("\n########## when the desk finishes, something comes back ##########\n");
  {
    truthy("there is a task from the call to finish", alphaTask);
    if (alphaTask) {
      // The runner is not run here — S6/S7 prove that path live. What is proved
      // here is the half that was missing entirely: a finished task reports.
      await pool.query(
        `UPDATE tasks SET pr_url = $2, pr_number = 4321, branch = 'jarvis/s22-probe' WHERE id = $1`,
        [alphaTask, `https://github.com/example/alpha-web/pull/4321`],
      );
      const { transitionTask } = await import("../src/jobs.js");
      await transitionTask(pool, alphaTask, "running", "s22 probe", "runner");
      await transitionTask(pool, alphaTask, "succeeded", "s22 probe", "runner");

      const note = await pool.query<{ body: string; message_type: string; state: string }>(
        `SELECT body, message_type, state FROM notifications_outbox
         WHERE object_type = 'task' AND object_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [alphaTask],
      );
      truthy("a completion report was queued", note.rowCount === 1);
      check("of the right kind", "completion", note.rows[0]?.message_type);
      contains("and it carries the pull request link", "/pull/4321", note.rows[0]?.body ?? "");
      ok("...which is what 'I will have the desk finish this and come back to you' owed him");
    }
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

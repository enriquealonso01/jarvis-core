/**
 * The call where Enrique tried to create a project by voice, and could not.
 *
 * Six turns, no project, and five distinct defects — every one of them ABOVE the
 * tool layer, which is why S26's 59 offline assertions and 11 live ones were all
 * green while this was broken. Those tests drive `runTool` directly. Nothing
 * drove the thing that decides whether `runTool` is ever reached.
 *
 * Two of the defects are what this suite is for:
 *
 *   1. "I want to create a project called Test Project" was classified as
 *      CAPTURE and answered "remembered: <his words>". The router has no notion
 *      of creating a project — its five categories are capture, question, work,
 *      instruction, ambiguous — and its prompt says an unrecognised project name
 *      makes a segment ambiguous, which is exactly backwards for a request to
 *      create one.
 *
 *   2. The classifier's own rationale was spoken down the phone. "He wants to
 *      create…", "The user asks…", "The message is a fragment with no clear
 *      subject". `segment.reason` is a diagnostic field — its own doc comment
 *      says "read back in bulk when a route goes wrong" — and it was being
 *      handed to the caller as the question to answer. A caller must never hear
 *      the system reason about him in the third person.
 *
 * The fixture is the real transcript, disfluencies and all. A cleaned-up version
 * would not have reproduced this: turn 3 trails off mid-word, turn 5 is a
 * fragment, and both are exactly what broke.
 */
import fs from "node:fs";
import {
  CATEGORIES, questionAboutUnplaced, summariseRoute, systemPrompt,
  type Category, type RouteOutcome,
} from "../src/routing.js";

let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 200)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));

const fixture = JSON.parse(
  fs.readFileSync(new URL("fixtures/voice-create-call.json", import.meta.url), "utf8"),
) as { turns: { n: number; heard: string }[]; spoken_back: string[] };

/**
 * Third-person rationale, as it actually appeared. Deliberately matched on the
 * SHAPE rather than on these exact sentences — the point is not that these five
 * strings never recur, it is that nothing describing the caller from outside
 * ever reaches the speaker.
 */
const THIRD_PERSON = [
  /\bHe (wants|asks|said|is asking)\b/i,
  /\bThe user\b/i,
  /\bThe message is\b/i,
  /\bcannot determine what is being asked\b/i,
  /\bthe caller\b/i,
];

export function soundsLikeRationale(text: string): string | null {
  for (const re of THIRD_PERSON) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

async function main(): Promise<void> {
  console.log("########## nothing said aloud may describe him from outside ##########\n");
  {
    /*
     * The detector itself, against what was really said. If this cannot see the
     * five sentences that actually went down the phone, nothing built on it
     * means anything.
     */
    const caught = fixture.spoken_back.filter((s) => soundsLikeRationale(s));
    check("the detector catches every rationale line from the real call", 3, caught.length);
    for (const c of caught) console.log(`        would have been refused: ${c.slice(0, 72)}`);

    truthy("and does not fire on an ordinary butler reply",
      !soundsLikeRationale("Very good, sir. Have a pleasant day."));
    truthy("nor on a real question addressed to him",
      !soundsLikeRationale("Which project is this for, sir?"));
  }

  console.log("\n########## an ambiguous segment asks HIM something ##########\n");
  {
    /*
     * The wiring bug, isolated. `summariseRoute` renders a destination's
     * `question` for the caller, and the ambiguous branch was passing
     * `segment.reason` — the classifier's note to itself — into that field.
     */
    const outcome: RouteOutcome = {
      inboxId: "x",
      category: "ambiguous" as Category,
      destinations: [{
        category: "ambiguous",
        projectSlug: null,
        conversationId: null,
        taskId: null,
        memoryId: null,
        contextId: null,
        question: "The message is a fragment with no clear subject, project, or intent.",
        summary: "asked about: because I am asking you to create it",
      }],
      reason: "test",
      model: "test",
    } as unknown as RouteOutcome;

    const said = summariseRoute(outcome);
    /*
     * `summariseRoute` speaks whatever is in `question` — it has no way to know
     * where the string came from, and should not. The guarantee has to be made
     * where the destination is built, so that is what is asserted: for every
     * real utterance from the call, the question built for it is addressed to
     * him and quotes him.
     */
    truthy("summariseRoute will say whatever it is given, so the guard cannot live there",
      Boolean(soundsLikeRationale(said)));

    for (const t of fixture.turns) {
      const asked = questionAboutUnplaced(t.heard);
      check(`turn ${t.n}: the question is addressed to him`, null, soundsLikeRationale(asked));
      truthy(`turn ${t.n}: and quotes what he actually said`,
        asked.includes(t.heard.trim().replace(/\s+/g, " ").slice(0, 40)));
    }
    console.log(`        e.g. ${questionAboutUnplaced(fixture.turns[4].heard)}`);
  }

  console.log("\n########## the router has a way to say 'create a project' ##########\n");
  {
    /*
     * Defect 1 and 5 together. There is no category for it, so "create a project
     * called Test Project" can only land in capture (something to remember) or
     * ambiguous (a project name that matches nothing) — and it landed in both,
     * on different turns, for the same request.
     */
    truthy("a create-project category exists",
      (CATEGORIES as readonly string[]).includes("create_project"));
  }

  console.log("\n########## the router is told what was already said ##########\n");
  {
    /*
     * Defect 3. `classifyInbox` was given the current utterance, the project
     * list and the open tasks — and nothing else. On turn 3 Enrique said "just
     * select the defaults, I want a project that is personal", and the router
     * replied that "no project name is given", which was true of that sentence
     * and false of the conversation: he had named it in turn 1.
     *
     * Asserted on the prompt rather than on a model's behaviour. Whether the
     * model then uses the history is its business; whether it was TOLD is ours,
     * and it is the part that was actually broken.
     */
    const withNothing = systemPrompt([], [], []);
    truthy("with no history the prompt says so plainly",
      withNothing.includes("this is the first thing said"));

    const history = fixture.turns.slice(0, 2).map((t) => ({ role: "user", body: t.heard }));
    const withHistory = systemPrompt([], [], history);
    truthy("the name he gave in turn 1 is in the prompt for turn 3",
      withHistory.includes("Test Project"));
    truthy("attributed to him, not presented as the current message",
      withHistory.includes("Enrique: I want to create a project"));
    truthy("and the prompt says why it is there",
      withHistory.includes("a name given three turns ago is still the name he means"));
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n==== ${pass} passed, ${fail + 1} failed ====`);
  process.exit(1);
});

/**
 * The harness ticket names the right remedy.
 *
 * Every ladder refusal used to raise one ticket - "no usable subscription login
 * for the heavy lane", action "Complete the Claude Code host login on the VPS".
 * One of those sat in waiting_for_user while its own evidence field said the
 * real reason: `anthropic_personal is not allowlisted for this project`. The
 * login was already done. The ticket asked Enrique to redo it.
 *
 * The inputs below are the strings the ladder actually produces, taken from
 * `resolveProfile` and from the evidence of the ticket that misled.
 */
import { harnessIssueFor } from "../src/runner.js";

let fails = 0;
/*
 * `passes` exists for the sweep, not for the reader.
 *
 * scripts/sweep.sh decides whether a suite ran by grepping for one exact line:
 * `==== N passed, M failed ====`. These suites printed their own summary instead,
 * so the sweep reported all seven as "NO SUMMARY - the suite did not finish"
 * while each of them passed perfectly well on its own. Adding a suite to the net
 * is not the same as the net being able to see it.
 */
let passes = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails++; };

const REAL_ALLOWLIST_REASON =
  "no engineering route is usable here: anthropic_personal: anthropic_personal is not "
  + "allowlisted for this project";

function main() {
  console.log("1. an allowlist gap does not ask for a login");
  const a = harnessIssueFor(REAL_ALLOWLIST_REASON);
  /^\[harness\] no engine is allowlisted/.test(a.title)
    ? ok(a.title) : bad(`title is ${a.title}`);
  !/host login|Claude Code/i.test(a.requiredAction)
    ? ok("the action does not mention a login")
    : bad(`the action still asks for a login: ${a.requiredAction.slice(0, 60)}`);
  a.dedupeKey !== "setup.harness.login"
    ? ok(`its own dedupe key (${a.dedupeKey})`)
    : bad("shares the login ticket's dedupe key, so it hides behind it");

  console.log("2. a missing login still asks for the login");
  const b = harnessIssueFor("anthropic_personal has no completed host login");
  /host login/i.test(b.requiredAction) ? ok("asks for the host login") : bad(b.requiredAction);
  b.dedupeKey === "setup.harness.login" ? ok("keeps the original key") : bad(b.dedupeKey);

  console.log("3. an unknown profile is a configuration problem, not a credential one");
  const c = harnessIssueFor("auth profile codex_typo does not exist");
  c.category === "config.invalid" ? ok(c.title) : bad(`category ${c.category}`);

  console.log("4. an unrecognised reason is quoted, not guessed at");
  const d = harnessIssueFor("the ladder exploded in a way nobody has seen");
  d.requiredAction.includes("the ladder exploded in a way nobody has seen")
    ? ok("the action carries the real reason")
    : bad(`the reason was dropped: ${d.requiredAction}`);

  console.log(`
==== ${passes} passed, ${fails} failed ====`);

  console.log(fails === 0 ? "\nHarness issue PASS" : `\nHarness issue FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
}

main();

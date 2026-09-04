/**
 * Adversarial probe of asking before the wall (S52).
 *
 * The step's own failure mode: "something that reaches out constantly is
 * something he mutes." Four rules hold it, and the probe goes at each — with
 * particular attention to rule THREE (it asks once) against rule FOUR (an
 * approval for one project is not an approval for another), because those two
 * are held by different mechanisms in the same file.
 */
import {
  capabilityKey, alreadyHave, register, asksFor, scopeOfConnectApproval,
  isRealNeed, scheduledCallOpening, ASK_AT, type Need, type NeedOrigin,
} from "../src/forthcoming.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); }
};
const need = (over: Partial<Need> = {}): Need => ({
  taskId: "t1", projectId: "alpha", kind: "credential", what: "a Maps API key", ...over,
} as Need);

console.log("\n== the ask precedes the block ==");
ok("asking happens before the work starts", ASK_AT === "before_start");

console.log("\n== it asks once ==");
const reg = register(new Set(), need());
ok("a registered need is not asked for again", alreadyHave(reg, need()) === true);
ok("the key ignores casing and padding",
  alreadyHave(reg, need({ what: "  A MAPS API KEY " })) === true);
ok("a different thing is still asked for", alreadyHave(reg, need({ what: "a Stripe key" })) === false);
ok("a different kind of the same thing is still asked for",
  alreadyHave(reg, need({ kind: "connection" })) === false);
ok("a satisfied task produces no message at all", asksFor([need()], reg).length === 0);

console.log("\n== it batches ==");
const two = asksFor([need(), need({ what: "a Stripe key" })]);
ok("two needs for one task make one message", two.length === 1, JSON.stringify(two.map((a) => a.taskId)));
ok("and the message names both",
  two[0].message.includes("Maps") && two[0].message.includes("Stripe"), two[0].message);
const split = asksFor([need(), need({ taskId: "t2", what: "a Stripe key" })]);
ok("two tasks make two messages", split.length === 2);

console.log("\n== a paid provider is a recommendation, not a request ==");
const rec = asksFor([need({ newProvider: "Mapbox" })]);
ok("it is a recommendation", rec[0].kind === "recommendation");
ok("and says the account is his to open", /yours to open/.test(rec[0].message), rec[0].message);
const mixed = asksFor([need(), need({ what: "a Mapbox plan", newProvider: "Mapbox" })]);
ok("one provider anywhere makes the whole message a recommendation",
  mixed[0].kind === "recommendation");
ok("an ordinary need is a request", asksFor([need()])[0].kind === "request");

console.log("\n== content is not a need ==");
ok("a task requirement is real", isRealNeed("task_requirement").real === true);
ok("a message mentioning one is not", isRealNeed("message_content").real === false);
ok("speculation is not", isRealNeed("speculation").real === false);
for (const junk of ["constructor", "__proto__", "", "TASK_REQUIREMENT", "task_requirement "]) {
  ok(`${JSON.stringify(junk)} is not a real need`, isRealNeed(junk as NeedOrigin).real === false);
}

console.log("\n== it never self-authorises from the ask ==");
const scope = scopeOfConnectApproval("alpha");
ok("connect is granted", scope.connect === true);
ok("spend is not", scope.spend === false);
ok("other projects are not", scope.otherProjects === false);
ok("and it is bound to the project that asked", scope.boundTo === "alpha");

console.log("\n== rule THREE against rule FOUR ==");
/*
 * scopeOfConnectApproval says an approval is bound to one project and explicitly
 * NOT for others. The register is what decides whether the next task asks — so
 * if it ignores the project, a credential acquired for alpha silently satisfies
 * beta's need, and beta's work sits blocked with no message. That is the exact
 * failure this step exists to prevent, arriving through its own register.
 */
const alphaReg = register(new Set(), need({ projectId: "alpha" } as Partial<Need>));
const betaNeed = need({ taskId: "t9", projectId: "beta" } as Partial<Need>);
ok("a credential acquired for alpha does NOT satisfy beta",
  alreadyHave(alphaReg, betaNeed) === false,
  `key(alpha)=${capabilityKey(need({ projectId: "alpha" } as Partial<Need>))} `
  + `key(beta)=${capabilityKey(betaNeed)}`);
ok("and beta still gets asked", asksFor([betaNeed], alphaReg).length === 1);
ok("but a CAPABILITY is not re-asked for across projects", (() => {
  const capReg = register(new Set(), need({ kind: "capability", what: "a PDF splitter" }));
  return alreadyHave(capReg, need({ kind: "capability", what: "a PDF splitter", projectId: "beta" })) === true;
})(), "a tool Jarvis built is reusable; S44 mayCall decides who may call it");

console.log("\n== a scheduled call opens with its purpose ==");
const withSubject = scheduledCallOpening({ greeting: "Morning", subject: "the Alpha migration" });
ok("it leads with the subject", withSubject.leadsWithSubject === true);
ok("and drives with a question", /\?$/.test(withSubject.say.trim()), withSubject.say);
const blank = scheduledCallOpening({ greeting: "Morning", subject: null });
ok("no subject is not a blank greeting", blank.leadsWithSubject === false);
ok("and it still says why the call is happening",
  /you asked me to call/.test(blank.say) && /\?$/.test(blank.say.trim()), blank.say);
ok("an empty-string subject is treated as no subject",
  scheduledCallOpening({ greeting: "Morning", subject: "" }).leadsWithSubject === false);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);

/**
 * A sweep for one bug class, not one module.
 *
 * Three modules this loop had the same defect: the guard was careful about what
 * it DID and trusting about what it was GIVEN. S50's mayDial(NaN) dialled a
 * stranger without limit, S48's correctedTo carried prose across the isolation
 * boundary, S54's promotion gate read the string "false" as a pass.
 *
 * So this stops probing modules one at a time and probes the CLASS: every gate
 * that answers "may this happen", given a value its type forbids. The question
 * each case asks is only ever "does the unexpected value fail closed".
 */
import { mayCall, ATTACHABLE_FORMS, type CapabilityForm } from "../src/capability.js";
import { mayDial } from "../src/outboundtask.js";
import { mayPromote, runnerUpdate, restorerSurvives } from "../src/selfdeploy.js";
import { handoffFor, mintAuthLink } from "../src/handoff.js";
import { approvalForCall } from "../src/outboundtask.js";
import { desktopAccess, facilityAccess } from "../src/desktop.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); }
};

const CLASSIFIED = {
  form: "script" as CapabilityForm,
  level: 1,
  classifiedHash: "abc",
  manifestHash: "abc",
  builtForProject: "p1",
  callingFromProject: "p1",
};

console.log("\n== capability.mayCall ==");
ok("a classified, unchanged, same-project tool is callable", mayCall(CLASSIFIED).allowed === true);
ok("a core change is never callable",
  mayCall({ ...CLASSIFIED, form: "core_change" }).allowed === false);
ok("unclassified (null level) is refused",
  mayCall({ ...CLASSIFIED, level: null }).allowed === false);
ok("UNCLASSIFIED (undefined level) is refused",
  mayCall({ ...CLASSIFIED, level: undefined as any }).allowed === false,
  JSON.stringify(mayCall({ ...CLASSIFIED, level: undefined as any })));
ok("a changed manifest is refused",
  mayCall({ ...CLASSIFIED, manifestHash: "def" }).allowed === false);
ok("a tool with no hashes at all is refused",
  mayCall({ ...CLASSIFIED, classifiedHash: null, manifestHash: null as any }).allowed === false,
  JSON.stringify(mayCall({ ...CLASSIFIED, classifiedHash: null, manifestHash: null as any })));
ok("another project's tool is refused",
  mayCall({ ...CLASSIFIED, callingFromProject: "p2" }).allowed === false);
for (const junk of ["constructor", "__proto__", "", "CORE_CHANGE"]) {
  ok(`form ${JSON.stringify(junk)} is not callable`,
    mayCall({ ...CLASSIFIED, form: junk as CapabilityForm }).allowed === false,
    JSON.stringify(mayCall({ ...CLASSIFIED, form: junk as CapabilityForm })));
}
for (const f of ATTACHABLE_FORMS) {
  ok(`${f} is callable when classified`, mayCall({ ...CLASSIFIED, form: f }).allowed === true);
}

console.log("\n== gates already fixed this loop, held under the same attack ==");
ok("mayDial(NaN) refuses", mayDial(NaN as number).dial === false);
ok("mayPromote with a string canary result refuses",
  mayPromote({ acceptanceSuitePassed: "false", evalSuitePassed: true,
    migration: { backwardCompatible: true }, touches: [] } as any).promote === false);
ok("runnerUpdate with an unknown requester refuses",
  runnerUpdate({ runnerBusy: false, requestedBy: "anything" as any }).apply === false);
ok("restorerSurvives with an unknown location refuses",
  restorerSurvives("anything" as any).survives === false);
ok("approvalForCall with an unknown origin asks",
  approvalForCall("anything" as any).asks === true);
ok("handoffFor with an unknown origin sends content",
  handoffFor({ origin: "anything" as any, link: mintAuthLink({
    provider: "g", authorizeUrl: "https://x.example/a", lifetimeMs: 1000 }) }).send === false);
ok("desktopAccess with an unknown scope and no declarations refuses",
  desktopAccess({ scope: "anything" as any, declaredPaths: [], requestedPath: "x",
    home: "/home/e" }).allowed === false);
ok("facilityAccess does not grant a prototype key",
  facilityAccess("constructor").allowed === true);

console.log(`==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);

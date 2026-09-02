/**
 * S28 — the runtime interface.
 *
 * The claim under test is the one the plan calls "probably the single most
 * important architectural decision we make": that a run is legible identically
 * whichever engine produced it. So the assertions are all of the form "these two
 * completely different streams normalise to the same shape", and the streams are
 * real.
 *
 * Provenance of the fixtures, because it matters:
 *
 * - `s28-codex-*.jsonl` are VERBATIM captures from `codex exec --json` on the
 *   box — one authenticated success, one 401 failure. Nothing invented.
 * - `s28-claude-*.jsonl` are reconstructed from the shapes recorded in
 *   `runner.ts`, the fake harness, and a real transcript on the box. The field
 *   names and the empty-string-result trap are from the real stream; the
 *   surrounding run is representative rather than a single captured session.
 *
 * The one assertion this suite CANNOT make is that the same task reaches a
 * passing PR on both engines. That needs a live run on each, and it is what the
 * step's first test asks for.
 */
import fs from "node:fs";
import { RUNTIMES, RUNTIME_IDS, runtimeAvailable, runtimeFor } from "../src/runtime.js";
import type { RuntimeEvent } from "../src/runtime.js";

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

function stream(name: string, runtimeId: string): RuntimeEvent[] {
  const rt = runtimeFor(runtimeId);
  if (!rt) throw new Error(`no runtime ${runtimeId}`);
  const text = fs.readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
  const events: RuntimeEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
    events.push(...rt.normalise(raw));
  }
  return events;
}

const kinds = (evts: RuntimeEvent[]) => evts.map((e) => e.kind);
const first = <K extends RuntimeEvent["kind"]>(evts: RuntimeEvent[], kind: K) =>
  evts.find((e) => e.kind === kind) as Extract<RuntimeEvent, { kind: K }> | undefined;

async function main(): Promise<void> {
  console.log("########## every runtime satisfies the interface ##########\n");
  {
    check("there are three", 3, RUNTIME_IDS.length);
    for (const id of RUNTIME_IDS) {
      const rt = RUNTIMES[id];
      const spec = rt.spawnSpec({ prompt: "do the thing", authDir: "/auth/dir", cwd: "/work" });
      truthy(`${id} names a command`, Boolean(spec.command));
      truthy(`${id} passes the prompt`, spec.args.some((a) => a.includes("do the thing")));
      /*
       * The auth directory must reach the child, under whatever name that
       * vendor uses. This is the assertion that would have caught the 401:
       * codex ignores CLAUDE_CONFIG_DIR entirely and reads CODEX_HOME.
       */
      truthy(`${id} passes the auth dir to the child`,
        Object.values(spec.env).includes("/auth/dir"));
      truthy(`${id} does NOT hardcode Claude's variable name`,
        id !== "codex" || spec.env.CODEX_HOME === "/auth/dir");
    }
    /*
     * The fake is the third implementation, and it is the reason to believe the
     * interface is an abstraction rather than a coincidence: "an interface that
     * only two real vendors fit is a coincidence".
     */
    truthy("the fake harness is one of them, not a special case",
      RUNTIMES.fake && RUNTIMES.fake.spawnSpec({ prompt: "x", authDir: "/a", cwd: "/w" }).command.length > 0);
  }

  console.log("\n########## two unrelated streams, one shape ##########\n");
  {
    const claude = stream("s28-claude-stream.jsonl", "claude");
    const codex = stream("s28-codex-stream.jsonl", "codex");

    // Session id, under two entirely different field names.
    check("claude reports a session", "5f2c1a8e-0b44-4d19-9a02-1c7de3b4a911",
      first(claude, "session")?.sessionId);
    check("codex reports a session, from thread_id", "01a06347-af54-7843-bf1e-36d512ad59cf",
      first(codex, "session")?.sessionId);

    // Output.
    truthy("claude's assistant text becomes output",
      claude.some((e) => e.kind === "output" && e.text.includes("reproduce the bug")));
    truthy("codex's agent_message becomes the same kind of output",
      codex.some((e) => e.kind === "output" && e.text === "OK"));

    // Result.
    const cr = first(claude, "result");
    const xr = first(codex, "result");
    check("claude ends with a result", true, cr?.ok);
    check("codex ends with a result too", true, xr?.ok);
    truthy("both call it a result, whatever the vendor called it",
      cr?.kind === "result" && xr?.kind === "result");

    /*
     * The shape, not the contents. A console that renders one and not the other
     * means the normalisation is incomplete — the plan says exactly that.
     */
    const shapeOf = (evts: RuntimeEvent[]) => [...new Set(kinds(evts))].sort().join(",");
    check("and the set of event kinds is identical",
      shapeOf(claude.filter((e) => e.kind !== "tool")),
      shapeOf(codex.filter((e) => e.kind !== "tool")));
  }

  console.log("\n########## a failure is a failure in both dialects ##########\n");
  {
    const claude = stream("s28-claude-failed.jsonl", "claude");
    const codex = stream("s28-codex-failed.jsonl", "codex");

    const cr = first(claude, "result");
    const xr = first(codex, "result");
    check("claude's failed run is not ok", false, cr?.ok);
    check("codex's failed run is not ok", false, xr?.ok);
    /*
     * The empty-string trap: a failing claude result carries `result: ""`,
     * which is not nullish, so a `??` chain records a blank summary. It must
     * normalise to null so the runner falls through to the subtype.
     */
    check("an empty claude result is null, not an empty summary", null, cr?.summary);
    check("...and the subtype survives to explain it", "error_max_turns", cr?.subtype);
    truthy("codex's failure carries its message", (xr?.summary ?? "").includes("401 Unauthorized"));
    truthy("and its errors are surfaced as errors",
      codex.some((e) => e.kind === "error" && e.message.includes("Reconnecting")));
  }

  console.log("\n########## what the run touched ##########\n");
  {
    const claude = stream("s28-claude-stream.jsonl", "claude");
    const tools = claude.filter((e) => e.kind === "tool").flatMap((e) => e.calls);
    check("claude's tool calls are extracted", 2, tools.length);
    check("with the command as the detail", "node --test",
      tools.find((t) => t.name === "Bash")?.detail);
    check("and the file path for an edit", "src/parse.ts",
      tools.find((t) => t.name === "Edit")?.detail);

    // Codex names what it did by item type; an unknown item is still reported
    // rather than dropped, because the console's job is to show what happened.
    const unknown = runtimeFor("codex")!.normalise({
      type: "item.completed",
      item: { id: "item_1", type: "command_execution", command: "pnpm test" },
    });
    check("an unrecognised codex item is still a tool call", "tool", unknown[0]?.kind);
    check("named by its item type", "command_execution",
      unknown[0]?.kind === "tool" ? unknown[0].calls[0].name : "");
    check("carrying what it ran", "pnpm test",
      unknown[0]?.kind === "tool" ? unknown[0].calls[0].detail : "");
  }

  console.log("\n########## a runtime that is not installed ##########\n");
  {
    /*
     * The plan wants a clean park with a useful message rather than a crash.
     * This is the check that decides it; the parking itself is the runner's.
     */
    const missing = await runtimeAvailable({
      id: "nope", displayName: "Nope", binary: "definitely-not-a-real-binary-xyz",
      spawnSpec: () => ({ command: "", args: [], env: {} }),
      normalise: () => [],
    });
    check("it is reported unavailable", false, missing.available);
    truthy("with a message that says what is missing",
      missing.detail.includes("definitely-not-a-real-binary-xyz"));

    const fake = await runtimeAvailable(RUNTIMES.fake);
    check("and the fake is always available", true, fake.available);
  }

  console.log("\n########## unknown ids are refused, not defaulted ##########\n");
  {
    check("an unknown runtime is null", null, runtimeFor("gpt-9"));
    check("an empty one too", null, runtimeFor(""));
    truthy("a known one resolves", runtimeFor("claude")?.id === "claude");
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n==== ${pass} passed, ${fail + 1} failed ====`);
  process.exit(1);
});

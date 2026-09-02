#!/usr/bin/env node
/**
 * The fake harness (plan S1).
 *
 * `runner.ts` was written, typechecked, and never once executed, because running
 * it needed Postgres, a Linux box, /var/lib/jarvis and a paid Claude
 * subscription. This script removes the last of those: with JARVIS_HARNESS=fake
 * the runner spawns this instead of `claude`, and the entire engineering loop is
 * exercisable offline.
 *
 * It speaks the same protocol `claude -p --output-format stream-json --verbose`
 * does: newline-delimited JSON on stdout, one object per line, a `system/init`
 * first, `assistant` messages in the middle, and one `result` last. The shapes
 * here are what the runner parses — session_id, type, and tool_use blocks — not
 * a full reproduction of the real event stream.
 *
 * Variants come from JARVIS_FAKE_VARIANT (the part after `fake:`):
 *   ok       — write a file, commit it, exit 0            (the happy path)
 *   crash    — write to stderr, exit 1                    -> harness.crash
 *   slow     — go silent past the silence limit           -> process.stuck
 *   runaway  — emit forever, never exit                   -> agent.loop
 *   noop     — talk, change nothing, exit 0               -> succeeded, empty diff
 *   escape   — try to write outside the worktree          -> blocked and audited
 *   probe    — read JARVIS_PROBE_PATH, another project's file -> S12/L9
 *   context  — wait for mid-run context, act on it        -> S3c, delivered at a checkpoint
 *   errorresult — is_error with an EMPTY result string    -> S4, must not be a blank summary
 *   workflow  — the S6 engineering loop, phase by phase   -> JARVIS_FAKE_WORKFLOW picks the outcome
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const variant = (process.env.JARVIS_FAKE_VARIANT || "ok").trim() || "ok";
const sessionId = crypto.randomUUID();
const cwd = process.cwd();

/** Emitting has to be unbuffered-ish: the runner's silence detector reads real time. */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function init() {
  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd,
    tools: ["Read", "Write", "Bash"],
    model: `fake-harness/${variant}`,
  });
}

function assistantText(text) {
  emit({
    type: "assistant",
    session_id: sessionId,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function assistantToolUse(name, input) {
  emit({
    type: "assistant",
    session_id: sessionId,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${crypto.randomBytes(6).toString("hex")}`, name, input }],
    },
  });
}

function result(subtype, text, isError = false) {
  emit({
    type: "result",
    subtype,
    session_id: sessionId,
    is_error: isError,
    duration_ms: 1234,
    num_turns: 3,
    result: text,
  });
}

function git(args, opts = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8", ...opts });
}

/**
 * Every variant that reaches the end of a run writes an outcome file.
 *
 * S6 made the verdict a separate claim from the exit code: a heavy run that
 * says nothing about what it achieved is incomplete, not successful. These
 * fixtures predate that protocol, so they were all being held for review —
 * correctly, by the new rule. Speaking the protocol is the fixture catching
 * up, not the rule being softened.
 */
function writeOutcome(verdict = "completed", extra = {}) {
  const dir = path.join(cwd, ".jarvis");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "outcome.json"),
    JSON.stringify({ reproduced: true, verdict, guess: false, confidence: "high", notes: "fake harness", ...extra }, null, 2),
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const prompt = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "";

  if (variant === "crash") {
    init();
    assistantText("Reading the repository.");
    process.stderr.write("fake-harness: simulated harness crash (login expired)\n");
    process.exit(1);
  }

  if (variant === "slow") {
    init();
    assistantText("Thinking about it.");
    // Then nothing at all. The runner's silence detector is the thing under test,
    // so this deliberately outlives it; the runner kills us with SIGTERM.
    const ms = Number(process.env.JARVIS_FAKE_SILENCE_MS ?? 11 * 60_000);
    await sleep(ms);
    result("success", "eventually finished");
    process.exit(0);
  }

  if (variant === "runaway") {
    init();
    // Never silent, never done: the run limit is the only thing that stops this.
    // A silent loop would be caught by the silence detector instead, which is a
    // different test.
    for (;;) {
      assistantText(`still working (${new Date().toISOString()})`);
      await sleep(1000);
    }
  }

  if (variant === "noop") {
    init();
    assistantText("I read the code and it already does what was asked. No changes needed.");
    writeOutcome("completed", { notes: "no change was needed" });
    result("success", "No changes were necessary.");
    process.exit(0);
  }

  if (variant === "escape") {
    init();
    // An absolute path outside the worktree. The runner must refuse this on the
    // event, and the unix permissions must refuse it on the filesystem; the two
    // are independent and both are asserted.
    const outside = path.join(path.dirname(path.dirname(cwd)), "escaped.txt");
    assistantToolUse("Write", { file_path: outside, content: "I should not be here." });
    let wrote = false;
    try {
      fs.writeFileSync(outside, "I should not be here.\n");
      wrote = true;
    } catch (err) {
      process.stderr.write(`fake-harness: escape blocked by filesystem: ${err.code}\n`);
    }
    await sleep(500);
    result("success", `escape attempt ${wrote ? "SUCCEEDED (filesystem did not stop it)" : "blocked"}`);
    process.exit(0);
  }

  if (variant === "probe") {
    // S12 / L9: the cross-project read. JARVIS_PROBE_PATH is another project's
    // file, browser profile, worktree or key — the thing a task in Alpha must
    // not be able to reach from Beta.
    //
    // Two independent layers are being asked about and they are asserted
    // separately, because they fail differently:
    //
    //   1. Does the runner SEE it? The path arrives in a Bash command string,
    //      which is where a real harness would put a `cat`, so this exercises
    //      the command scanner rather than the tidy path-argument case.
    //   2. Does the filesystem STOP it? For a personal project it does not —
    //      the runner and every worktree are the same unix user, by design
    //      (ADR 006 step 5 allocates a dedicated uid only for professional and
    //      confidential projects). So the honest report is what actually
    //      happened, printed either way, and the test asserts on both.
    init();
    const target = process.env.JARVIS_PROBE_PATH || "/var/lib/jarvis/projects/other/repo/SECRET";
    assistantToolUse("Bash", { command: `cat ${target}` });
    let read = null;
    try {
      read = fs.readFileSync(target, "utf8").trim();
    } catch (err) {
      process.stderr.write(`fake-harness: probe blocked by filesystem: ${err.code}
`);
    }
    process.stderr.write(`fake-harness: probe read=${read === null ? "DENIED" : "ALLOWED"}
`);
    await sleep(400);
    result("success", `probe of ${target}: ${read === null ? "denied by filesystem" : `READ ${read.length} bytes`}`);
    process.exit(0);
  }

  if (variant === "fixtest") {
    // S8: make a real failing test pass, by editing real source.
    //
    // The plan is explicit that an acceptance test which passes on a run where
    // the harness plainly did nothing is asserting the task row rather than the
    // diff. So this variant does not fake a fix — it applies one, and the
    // assertion downstream is the seeded test going from red to green.
    init();
    const jdir = path.join(cwd, ".jarvis");
    fs.mkdirSync(jdir, { recursive: true });
    const say = (phase, note) => {
      fs.appendFileSync(path.join(jdir, "phases.jsonl"), JSON.stringify({ phase, note }) + "\n");
      assistantText(`${phase}: ${note}`);
    };
    for (const p of ["preserve","context","reproduce","inspect","root_cause","plan"]) say(p, `at ${p}`);
    const target = path.join(cwd, "src", "answer.js");
    const before = fs.readFileSync(target, "utf8");
    const after = before.replace("return 41;", "return 42;");
    if (after === before) {
      process.stderr.write("fake-harness: nothing to fix in src/answer.js\n");
      process.exit(1);
    }
    fs.writeFileSync(target, after);
    assistantToolUse("Edit", { file_path: target, content: "return 42" });
    say("change", "answer() returned 41; it should return 42");
    say("tests", "the seeded test already covers this");
    const check = spawnSync("node", ["--test"], { cwd, encoding: "utf8" });
    say("checks", `node --test exited ${check.status}`);
    git(["add", "-A"]);
    git(["-c", "user.email=fake@jarvis.local", "-c", "user.name=Fake Harness", "commit", "-m", "Return 42 from answer()"]);
    say("commit", "committed the fix");
    writeOutcome("completed", { notes: "answer() returned 41; changed it to 42 so the seeded test passes" });
    result("success", "fixed answer() and the seeded test passes");
    process.exit(0);
  }

  // --- S6: the engineering loop, announced phase by phase ---------------
  if (variant.startsWith("workflow")) {
    // workflow        -> all phases, verdict completed
    // workflow:norepro-> stops at reproduce, verdict not_reproducible
    // workflow:guess  -> all phases but guess: true
    // workflow:scope  -> declines, verdict out_of_scope
    // workflow:prefail-> verdict pre_existing_failure
    // workflow:silent -> does the work but writes NO outcome.json
    // workflow:halt   -> stops partway, for the resume test
    const mode = (process.env.JARVIS_FAKE_WORKFLOW ?? "full");
    init();
    const jdir = path.join(cwd, ".jarvis");
    fs.mkdirSync(jdir, { recursive: true });
    // S14: a real harness emits a tool_use for every file it reads and every
    // command it runs, and the runner records those so the console can say what
    // a run is DOING rather than only that it is doing something. A fixture that
    // emits nothing but prose exercises the phase path and nothing else — the
    // tool timeline would have been asserted against an empty list and passed.
    const PHASE_TOOL = {
      preserve: ["Bash", "git status --porcelain"],
      context: ["Read", "AGENTS.md"],
      reproduce: ["Bash", "npm test -- cart"],
      inspect: ["Grep", "function total"],
      root_cause: ["Read", "src/cart.js"],
      plan: ["Write", ".jarvis/plan.md"],
      change: ["Edit", "src/cart.js"],
      tests: ["Bash", "npm test"],
      checks: ["Bash", "npm run lint"],
      commit: ["Bash", "git commit -m fix"],
      push: ["Bash", "git push -u origin HEAD"],
    };
    // How long each phase takes. The default keeps every existing suite as fast
    // as it was; a test that has to WATCH a run happen turns it up.
    const phaseMs = Number(process.env.JARVIS_FAKE_PHASE_MS || 150);
    const announce = (phase, note) => {
      fs.appendFileSync(path.join(jdir, "phases.jsonl"), JSON.stringify({ phase, note }) + "\n");
      const tool = PHASE_TOOL[phase];
      if (tool) {
        assistantToolUse(
          tool[0],
          tool[0] === "Bash" ? { command: tool[1] }
            : tool[0] === "Grep" ? { pattern: tool[1] }
            : { file_path: tool[1] },
        );
      }
      assistantText(`entering ${phase}: ${note}`);
    };
    const ALL = ["preserve","context","reproduce","inspect","root_cause","plan","change","tests","checks","commit","push"];
    const stopAfter = { norepro: "reproduce", scope: "context", prefail: "checks", halt: "inspect", noreprocrash: "reproduce" }[mode];
    const resumeAt = process.env.JARVIS_FAKE_RESUME_AT || null;
    const start = resumeAt ? Math.max(0, ALL.indexOf(resumeAt)) : 0;
    for (let i = start; i < ALL.length; i += 1) {
      const ph = ALL[i];
      announce(ph, `fake harness at ${ph}`);
      await sleep(phaseMs);
      if (ph === "change" && mode !== "scope" && mode !== "norepro") {
        fs.writeFileSync(path.join(cwd, "FIX.md"), `fixed by the fake harness (${mode})\n`);
      }
      if (stopAfter && ph === stopAfter) break;
    }
    const outcome = {
      full:    { reproduced: true,  verdict: "completed",            guess: false, confidence: "high",   notes: "found the cause and fixed it" },
      guess:   { reproduced: false, verdict: "completed",            guess: true,  confidence: "low",    notes: "changed something plausible but I am not sure" },
      norepro: { reproduced: false, verdict: "not_reproducible",     guess: false, confidence: "medium", notes: "could not make it happen", attempted: ["ran the suite","tried the described steps"], missing: ["the exact input"] },
      noreprocrash: { reproduced: false, verdict: "not_reproducible", guess: false, confidence: "medium", notes: "could not make it happen and stopped", attempted: ["tried the described steps"], missing: ["the exact input"] },
      scope:   { reproduced: false, verdict: "out_of_scope",         guess: false, confidence: "high",   notes: "this asks for a change in a different system" },
      prefail: { reproduced: true,  verdict: "pre_existing_failure",  guess: false, confidence: "high",   notes: "the suite was already red before I touched it" },
      halt:    null,
      silent:  null,
    }[mode];
    if (outcome) fs.writeFileSync(path.join(jdir, "outcome.json"), JSON.stringify(outcome, null, 2));
    // Stops early AND exits non-zero, but says why first. The runner must honour
    // the report rather than recording harness.crash.
    if (mode === "noreprocrash") {
      process.stderr.write("fake-harness: stopped at reproduce\n");
      process.exit(1);
    }
    if (mode === "halt") {
      process.stderr.write("fake-harness: halted partway on purpose\n");
      process.exit(1);
    }
    // A run that declined or could not reproduce has nothing to commit.
    const commits = mode !== "scope" && mode !== "norepro";
    const inRepoW = commits && git(["rev-parse", "--is-inside-work-tree"]).status === 0;
    if (inRepoW) {
      git(["add", "-A"]);
      git(["-c", "user.email=fake@jarvis.local", "-c", "user.name=Fake Harness", "commit", "-m", `fake: ${mode}`]);
    }
    result("success", `workflow ${mode}`);
    process.exit(0);
  }

  // --- S11: the five mid-run failures, each with its own taxonomy class ---
  if (variant === "fail") {
    // JARVIS_FAKE_FAILURE picks which. The text is what a real harness prints;
    // the runner classifies from it, so the fixture must not hand over a class
    // directly or the test would be asserting its own input.
    const kind = process.env.JARVIS_FAKE_FAILURE ?? "crash";
    const messages = {
      limit:   "Claude usage limit reached. Your limit will reset at 3pm.",
      revoked: "API Error: 401 Unauthorized - invalid api key; please run `claude login`",
      disk:    "Error: ENOSPC: no space left on device, write",
      network: "TypeError: fetch failed ... getaddrinfo ENOTFOUND api.anthropic.com",
      ratelimit: "API Error: 429 Too Many Requests (retry-after: 30)",
      crash:   "Segmentation fault in the harness",
    };
    init();
    assistantText("starting work");
    const jdir = path.join(cwd, ".jarvis");
    fs.mkdirSync(jdir, { recursive: true });
    for (const ph of ["preserve", "context", "reproduce"]) {
      fs.appendFileSync(path.join(jdir, "phases.jsonl"), JSON.stringify({ phase: ph, note: "before the failure" }) + "\n");
    }
    emit({ type: "result", subtype: "error_during_execution", session_id: sessionId,
           is_error: true, duration_ms: 500, num_turns: 1,
           result: messages[kind] ?? messages.crash });
    process.exit(1);
  }

  if (variant === "errorresult") {
    // Reproduces exactly what a real `claude -p --output-format stream-json`
    // run emitted when it hit --max-turns: exit 1, is_error true, a subtype
    // naming the failure, and result: "" — the empty string that used to slip
    // past `??` and record a failed task with a blank summary.
    init();
    assistantText("Working.");
    emit({
      type: "result",
      subtype: "error_max_turns",
      session_id: sessionId,
      is_error: true,
      duration_ms: 900,
      num_turns: 2,
      result: "",
    });
    process.exit(1);
  }

  if (variant === "context") {
    // Waits for the runner to hand it something, the way a real long run would
    // notice a file appear in its worktree. Proves S3c end to end: not "a row
    // was marked delivered", but "the harness read his words and committed
    // something because of them".
    init();
    assistantText("Starting the long job.");
    const dir = path.join(cwd, ".jarvis", "context");
    const deadline = Date.now() + Number(process.env.JARVIS_FAKE_CONTEXT_WAIT_MS ?? 60_000);
    let found = [];
    while (Date.now() < deadline) {
      try {
        const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
        if (entries.length) {
          found = entries.map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
          break;
        }
      } catch {
        /* the directory does not exist until the runner writes into it */
      }
      assistantText("still working, nothing new yet");
      await sleep(1000);
    }
    // Keep working after the context arrives, so a test can interrupt a run that
    // has already done something worth losing (S4 test 2). Zero by default: the
    // S3c test wants this variant to finish as soon as it has read the context.
    const hold = Number(process.env.JARVIS_FAKE_CONTEXT_HOLD_MS ?? 0);
    const holdUntil = Date.now() + hold;
    while (Date.now() < holdUntil) {
      assistantText("still working after reading the new context");
      await sleep(1000);
    }
    const out = path.join(cwd, "CONTEXT_SEEN.md");
    fs.writeFileSync(out, found.length ? found.join("\n---\n") : "NO CONTEXT ARRIVED\n");
    assistantToolUse("Write", { file_path: out, content: "what the runner handed me" });
    const inRepo2 = git(["rev-parse", "--is-inside-work-tree"]).status === 0;
    if (inRepo2) {
      git(["add", "-A"]);
      git(["-c", "user.email=fake@jarvis.local", "-c", "user.name=Fake Harness", "commit", "-m", "fake: acted on mid-run context"]);
    }
    writeOutcome();
    result("success", found.length ? `acted on ${found.length} piece(s) of new context` : "no context arrived");
    process.exit(0);
  }

  // ok — the happy path.
  init();
  assistantText(`Working on: ${prompt.slice(0, 120)}`);
  const file = path.join(cwd, "JARVIS_FAKE_RUN.md");
  assistantToolUse("Write", { file_path: file, content: "written by the fake harness" });
  fs.writeFileSync(
    file,
    `# fake harness run\n\nsession: ${sessionId}\nvariant: ${variant}\nprompt: ${prompt}\n`,
  );
  await sleep(200);
  assistantToolUse("Bash", { command: "git add -A && git commit" });
  const inRepo = git(["rev-parse", "--is-inside-work-tree"]).status === 0;
  if (inRepo) {
    git(["add", "-A"]);
    const c = git(["-c", "user.email=fake@jarvis.local", "-c", "user.name=Fake Harness", "commit", "-m", `fake: ${prompt.slice(0, 60) || "run"}`]);
    if (c.status !== 0) {
      process.stderr.write(`fake-harness: commit failed: ${c.stderr}\n`);
    }
  }
  await sleep(200);
  writeOutcome();
  result("success", `Wrote JARVIS_FAKE_RUN.md and committed it${inRepo ? "" : " (no repo, file only)"}.`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`fake-harness: ${err?.stack ?? err}\n`);
  process.exit(1);
});

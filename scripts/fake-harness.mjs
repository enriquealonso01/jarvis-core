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
 *   context  — wait for mid-run context, act on it        -> S3c, delivered at a checkpoint
 *   errorresult — is_error with an EMPTY result string    -> S4, must not be a blank summary
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
  result("success", `Wrote JARVIS_FAKE_RUN.md and committed it${inRepo ? "" : " (no repo, file only)"}.`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`fake-harness: ${err?.stack ?? err}\n`);
  process.exit(1);
});

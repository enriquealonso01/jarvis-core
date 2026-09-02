/**
 * S28 — the runtime interface.
 *
 * "Jarvis must never *be* its harness." The runner spawns a vendor CLI and
 * reads its stdout, and both of those are vendor-specific in ways that are easy
 * to let leak everywhere: the flags, the config-directory environment variable,
 * and above all the event shape. This module is the seam.
 *
 * What is NOT here matters as much as what is. The privilege drop (ADR 016),
 * the network namespace, the transcript scrubber and the escaped-path tripwire
 * all stay in the runner, because they are Jarvis's containment and they apply
 * to every runtime. A runtime describes how to start a vendor and how to read
 * it. It is given no say in whether it is contained.
 *
 * **The event shapes are recorded, not guessed.** Both were captured from real
 * runs on the box and are in `scripts/fixtures/`:
 *
 *   claude  {"type":"system","subtype":"init",...} / {"type":"assistant",
 *           "message":{"content":[{"type":"tool_use","name":...}]}} /
 *           {"type":"result","is_error":false,"subtype":"success","result":"..."}
 *           with `session_id` on every line.
 *
 *   codex   {"type":"thread.started","thread_id":"..."} / {"type":"turn.started"}
 *           / {"type":"item.completed","item":{"type":"agent_message","text":...}}
 *           / {"type":"turn.completed","usage":{...}} / {"type":"turn.failed",
 *           "error":{"message":...}}
 *
 * They have nothing in common. That is the point: if the interface had been
 * designed against Claude alone it would have been Claude's shape wearing a
 * different name, and the plan says so — "an interface that only two real
 * vendors fit is a coincidence, not an abstraction."
 */

/** One thing the agent did, in terms the console and the runner understand. */
export type RuntimeToolCall = { name: string; detail: string };

/**
 * The normalised event. Every runtime produces these and nothing else; the
 * console, `task_events` and the evaluation suite see only this shape, so a run
 * is legible identically whichever engine produced it.
 */
export type RuntimeEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "tool"; calls: RuntimeToolCall[] }
  | { kind: "output"; text: string }
  | { kind: "error"; message: string }
  | {
      kind: "result";
      ok: boolean;
      /** What it says it did, or why it stopped. */
      summary: string | null;
      /** The vendor's own word for the outcome, kept for the taxonomy. */
      subtype: string | null;
    };

export type SpawnSpec = {
  command: string;
  args: string[];
  /** Added to the child environment. The config-dir variable lives here. */
  env: Record<string, string>;
};

export interface AgentRuntime {
  /** Stored on the task, so "which engine ran this?" is answerable. */
  readonly id: string;
  readonly displayName: string;
  /**
   * How to start it for one non-interactive run that must not stop to ask.
   * `authDir` is the profile's own directory — never a shared one.
   */
  spawnSpec(args: { prompt: string; authDir: string; cwd: string }): SpawnSpec;
  /** One parsed stdout object in; zero or more normalised events out. */
  normalise(raw: Record<string, unknown>): RuntimeEvent[];
  /** The binary this runtime needs, for the "not installed" check. */
  readonly binary: string;
}

/** Claude Code, and the fake harness, which deliberately mimics its stream. */
class ClaudeLikeRuntime implements AgentRuntime {
  constructor(
    readonly id: string,
    readonly displayName: string,
    readonly binary: string,
    private readonly fake: boolean,
  ) {}

  spawnSpec(args: { prompt: string; authDir: string; cwd: string }): SpawnSpec {
    if (this.fake) {
      return {
        command: process.execPath,
        args: [`${process.cwd()}/scripts/fake-harness.mjs`, args.prompt],
        env: { CLAUDE_CONFIG_DIR: args.authDir },
      };
    }
    return {
      command: "claude",
      args: [
        "-p", args.prompt,
        "--output-format", "stream-json",
        "--verbose",
        /*
         * `bypassPermissions` rather than `acceptEdits`: the first real S6 run
         * proved acceptEdits cannot run tests, so the loop could never honestly
         * finish. Containment is the unix user, the namespace and the path
         * tripwire — not this flag.
         */
        "--permission-mode", "bypassPermissions",
      ],
      env: { CLAUDE_CONFIG_DIR: args.authDir },
    };
  }

  normalise(raw: Record<string, unknown>): RuntimeEvent[] {
    const out: RuntimeEvent[] = [];
    if (typeof raw.session_id === "string" && raw.session_id) {
      out.push({ kind: "session", sessionId: raw.session_id });
    }
    const calls = claudeToolCalls(raw);
    if (calls.length) out.push({ kind: "tool", calls });

    if (raw.type === "assistant") {
      const text = claudeText(raw);
      if (text) out.push({ kind: "output", text });
    }
    if (raw.type === "result") {
      /*
       * The empty-string trap, from a real run (S4): a failing result has
       * `is_error: true`, a `subtype` naming the failure, and `result: ""`.
       * An empty string is not nullish, so `??` never fires and a failed task
       * is recorded with a blank summary.
       */
      const summary = typeof raw.result === "string" && raw.result.trim() ? raw.result : null;
      out.push({
        kind: "result",
        ok: raw.is_error === true ? false : true,
        summary,
        subtype: typeof raw.subtype === "string" ? raw.subtype : null,
      });
    }
    return out;
  }
}

/**
 * Codex.
 *
 * Its stream shares not one field name with Claude's. `thread_id` is the
 * session, a turn ends with `turn.completed` or `turn.failed` rather than a
 * `result` object, and everything the agent produces arrives wrapped in
 * `item.completed`.
 */
class CodexRuntime implements AgentRuntime {
  readonly id = "codex";
  readonly displayName = "Codex CLI";
  readonly binary = "codex";

  spawnSpec(args: { prompt: string; authDir: string; cwd: string }): SpawnSpec {
    return {
      command: "codex",
      args: [
        "exec",
        "--json",
        // The worktree is a git repo in normal use, but a run must not die when
        // it is not one.
        "--skip-git-repo-check",
        "-C", args.cwd,
        /*
         * The counterpart of Claude's bypassPermissions, and its own help text
         * says it is "intended solely for running in environments that are
         * externally sandboxed" — which is precisely this one: a dedicated unix
         * user, a network namespace, and a path tripwire that kills the run.
         */
        "--dangerously-bypass-approvals-and-sandbox",
        args.prompt,
      ],
      /*
       * NOT `CLAUDE_CONFIG_DIR`. Codex reads `CODEX_HOME`, and without it it
       * silently uses ~/.codex, finds nothing, and fails with 401 Unauthorized
       * — which looks exactly like an expired subscription. Learned the hard
       * way against the live CLI.
       */
      env: { CODEX_HOME: args.authDir },
    };
  }

  normalise(raw: Record<string, unknown>): RuntimeEvent[] {
    const out: RuntimeEvent[] = [];
    const type = typeof raw.type === "string" ? raw.type : "";

    if (type === "thread.started" && typeof raw.thread_id === "string") {
      out.push({ kind: "session", sessionId: raw.thread_id });
    }
    if (type === "error" && typeof raw.message === "string") {
      out.push({ kind: "error", message: raw.message });
    }
    if (type === "item.completed") {
      const item = (raw.item ?? {}) as Record<string, unknown>;
      const itemType = typeof item.type === "string" ? item.type : "";
      if (itemType === "agent_message" && typeof item.text === "string") {
        out.push({ kind: "output", text: item.text });
      } else if (itemType === "error" && typeof item.message === "string") {
        out.push({ kind: "error", message: item.message });
      } else if (itemType) {
        /*
         * Anything else the agent DID — running a command, changing a file.
         * Reported as a tool call rather than dropped: the console's job is to
         * show what a run touched, and an unrecognised item type is still
         * something that happened. Codex names these by item type.
         */
        const detail =
          typeof item.command === "string" ? item.command
          : typeof item.path === "string" ? item.path
          : typeof item.text === "string" ? item.text
          : "";
        out.push({ kind: "tool", calls: [{ name: itemType, detail: detail.slice(0, 500) }] });
      }
    }
    if (type === "turn.completed") {
      out.push({ kind: "result", ok: true, summary: null, subtype: "success" });
    }
    if (type === "turn.failed") {
      const err = (raw.error ?? {}) as Record<string, unknown>;
      out.push({
        kind: "result",
        ok: false,
        summary: typeof err.message === "string" ? err.message : null,
        subtype: "turn_failed",
      });
    }
    return out;
  }
}

/** Tool calls out of a Claude `assistant` message. */
function claudeToolCalls(event: Record<string, unknown>): RuntimeToolCall[] {
  if (event.type !== "assistant") return [];
  const message = (event.message ?? {}) as Record<string, unknown>;
  const content = Array.isArray(message.content) ? message.content : [];
  const calls: RuntimeToolCall[] = [];
  for (const part of content) {
    const p = (part ?? {}) as Record<string, unknown>;
    if (p.type !== "tool_use" || typeof p.name !== "string") continue;
    const input = (p.input ?? {}) as Record<string, unknown>;
    const detail =
      typeof input.command === "string" ? input.command
      : typeof input.file_path === "string" ? input.file_path
      : typeof input.path === "string" ? input.path
      : typeof input.pattern === "string" ? input.pattern
      : "";
    calls.push({ name: p.name, detail: detail.slice(0, 500) });
  }
  return calls;
}

function claudeText(event: Record<string, unknown>): string {
  const message = (event.message ?? {}) as Record<string, unknown>;
  const content = Array.isArray(message.content) ? message.content : [];
  const parts: string[] = [];
  for (const part of content) {
    const p = (part ?? {}) as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n").trim();
}

export const RUNTIMES: Record<string, AgentRuntime> = {
  claude: new ClaudeLikeRuntime("claude", "Claude Code", "claude", false),
  fake: new ClaudeLikeRuntime("fake", "Fake harness", process.execPath, true),
  codex: new CodexRuntime(),
};

/** Every runtime id, for validation and for the console. */
export const RUNTIME_IDS = Object.keys(RUNTIMES);

export function runtimeFor(id: string | null | undefined): AgentRuntime | null {
  if (!id) return null;
  return RUNTIMES[id] ?? null;
}

/**
 * Is the binary actually there?
 *
 * The plan: "Point a task at a runtime that is not installed → a clean
 * `provider.cred_expired`-class park with a useful message, not a crash." The
 * check is a `which`, deliberately: asking the CLI for its version costs a
 * process spawn and a second of latency on a path that runs before every task.
 */
export async function runtimeAvailable(
  rt: AgentRuntime,
): Promise<{ available: boolean; detail: string }> {
  if (rt.binary === process.execPath) return { available: true, detail: "node" };
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn("which", [rt.binary], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.on("error", () =>
      resolve({ available: false, detail: `cannot check for ${rt.binary}` }));
    child.on("close", (code) =>
      resolve(code === 0 && out.trim()
        ? { available: true, detail: out.trim() }
        : { available: false, detail: `${rt.binary} is not installed on this host` }));
  });
}

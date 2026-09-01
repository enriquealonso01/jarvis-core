import fs from "node:fs";
import crypto from "node:crypto";

/**
 * A scripted stand-in for the model (plan S1's test environment, used by S2).
 *
 * The dev stack has no provider credential and no network, so without this the
 * Supervisor cannot complete a single turn and `task_create` would have to be
 * tested by calling the function directly — which proves the SQL and nothing
 * about the tool actually being reachable through a turn.
 *
 * It is not a model and does not pretend to be one. It matches the last user
 * message against a script and replays a fixed tool call, so a test can assert
 * "given the model asks for this, does the right row appear, with the right
 * provenance, and do the refusals refuse". Whether a real model *chooses*
 * task_create over memory_upsert is a different question and needs a real route.
 */

export type FakeTurn = {
  /** Substring of the last user message, matched case-insensitively. */
  match: string;
  tool_calls?: { name: string; arguments: Record<string, unknown> }[];
  content?: string;
};

export const FAKE_MODEL = process.env.JARVIS_MODEL === "fake";

function loadScript(): FakeTurn[] {
  const path = process.env.JARVIS_FAKE_MODEL_SCRIPT;
  if (!path) return [];
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as FakeTurn[];
  } catch {
    return [];
  }
}

type Msg = { role: string; content?: unknown; name?: string };

export function fakeCompletion(messages: Msg[]): {
  role: "assistant";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
} {
  // A tool has already run this turn, so the loop must be allowed to end.
  // Without this the fake would replay the same tool call forever and every test
  // would hit the eight-call limit instead of its assertion.
  if (messages.some((m) => m.role === "tool")) {
    const last = [...messages].reverse().find((m) => m.role === "tool");
    const result = typeof last?.content === "string" ? last.content : "";
    return { role: "assistant", content: result.startsWith("ERROR") ? `I could not do that. ${result}` : "Done." };
  }

  const user = [...messages].reverse().find((m) => m.role === "user");
  const text = typeof user?.content === "string" ? user.content.toLowerCase() : "";
  const turn = loadScript().find((t) => text.includes(t.match.toLowerCase()));
  if (!turn) return { role: "assistant", content: "(fake model: no scripted turn matched)" };
  if (!turn.tool_calls?.length) return { role: "assistant", content: turn.content ?? "(fake model)" };

  return {
    role: "assistant",
    content: turn.content ?? null,
    tool_calls: turn.tool_calls.map((c) => ({
      id: `call_${crypto.randomBytes(6).toString("hex")}`,
      type: "function" as const,
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    })),
  };
}

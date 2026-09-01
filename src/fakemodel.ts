import fs from "node:fs";
import crypto from "node:crypto";

/**
 * A scripted stand-in for the model (plan S1's test environment, used by S2/S3).
 *
 * The dev stack has no provider credential and no network, so without this the
 * Supervisor cannot complete a single turn and `task_create` would have to be
 * tested by calling the function directly - which proves the SQL and nothing
 * about the tool actually being reachable through a turn.
 *
 * It is not a model and does not pretend to be one. It matches the last user
 * message against a script and replays a fixed reply, so a test can assert
 * "given the model says this, does the right row appear, with the right
 * provenance, and do the refusals refuse". Whether a real model *chooses*
 * task_create over memory_upsert, or splits a memo into the right three
 * segments, is a different question and needs a real route.
 *
 * Two scripts live in one file because two different prompts run through here:
 * the router (S3), which is keyed on a marker in its system prompt, and the
 * Supervisor's tool loop. Without the split, a fixture written for one would be
 * replayed to the other.
 */

export type FakeTurn = {
  /** Substring of the last user message, matched case-insensitively. */
  match: string;
  tool_calls?: { name: string; arguments: Record<string, unknown> }[];
  content?: string;
  /** Router turns answer with JSON; this is serialised into `content`. */
  json?: unknown;
};

type FakeScript = { supervisor?: FakeTurn[]; classifier?: FakeTurn[] } | FakeTurn[];

export const FAKE_MODEL = process.env.JARVIS_MODEL === "fake";

/** Must match ROUTE_CLASSIFIER_MARKER in routing.ts. Duplicated to avoid an import cycle. */
const CLASSIFIER_MARKER = "route classifier";

function loadScript(): { supervisor: FakeTurn[]; classifier: FakeTurn[] } {
  const path = process.env.JARVIS_FAKE_MODEL_SCRIPT;
  if (!path) return { supervisor: [], classifier: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as FakeScript;
    if (Array.isArray(parsed)) return { supervisor: parsed, classifier: [] };
    return { supervisor: parsed.supervisor ?? [], classifier: parsed.classifier ?? [] };
  } catch {
    return { supervisor: [], classifier: [] };
  }
}

type Msg = { role: string; content?: unknown; name?: string };

function textOf(m: Msg | undefined): string {
  return typeof m?.content === "string" ? m.content : "";
}

export function fakeCompletion(messages: Msg[]): {
  role: "assistant";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
} {
  const script = loadScript();
  const system = messages.filter((m) => m.role === "system").map(textOf).join("\n").toLowerCase();
  const isRouter = system.includes(CLASSIFIER_MARKER);

  // A tool has already run this turn, so the loop must be allowed to end.
  // Without this the fake would replay the same tool call forever and every test
  // would hit the eight-call limit instead of its assertion.
  if (!isRouter && messages.some((m) => m.role === "tool")) {
    const last = [...messages].reverse().find((m) => m.role === "tool");
    const result = textOf(last);
    return { role: "assistant", content: result.startsWith("ERROR") ? `I could not do that. ${result}` : "Done." };
  }

  const user = [...messages].reverse().find((m) => m.role === "user");
  const text = textOf(user).toLowerCase();
  const turns = isRouter ? script.classifier : script.supervisor;
  const turn = turns.find((t) => text.includes(t.match.toLowerCase()));

  if (!turn) {
    // The router must fail closed: no scripted verdict means no verdict, and
    // routing.ts turns that into `ambiguous` rather than a guess.
    return { role: "assistant", content: isRouter ? "" : "(fake model: no scripted turn matched)" };
  }
  if (turn.json !== undefined) return { role: "assistant", content: JSON.stringify(turn.json) };
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

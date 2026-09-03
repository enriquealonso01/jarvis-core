/**
 * The second rung: a fetch that survives a TLS fingerprint check (plan S32).
 *
 *   "2. Fingerprinted HTTP — a TLS-fingerprinting client for sites that reject
 *    stock clients on JA3/JA4 before serving any content."
 *
 * `fetchtier.ts` shipped this rung declared and deliberately unimplemented,
 * because the plan asked Enrique which client he meant by "Paw HTTPS" and
 * guessing "would produce a rung that looks present and fails in a way nobody
 * could distinguish from a site problem". BLOCKERS B8 answers it: powhttp, which
 * ships as an MCP server rather than as a library.
 *
 * That answer is convenient in a way worth stating, because it decides the shape
 * of this file. An MCP server is something this codebase already knows how to
 * run without trusting it: `sandboxArgv` gives it a read-only rootfs, no
 * capabilities, no environment, no project volume and a pinned memory and
 * process limit. So the fingerprinting client is not linked into the runner - it
 * is a container that is handed a URL and gives back bytes, and the bytes are
 * data.
 *
 * WHAT THIS RUNG NEEDS THAT NO OTHER SANDBOXED SERVER DOES: egress. Every other
 * MCP server here runs on `--network none`. A fetcher obviously cannot, and that
 * is the whole reason `SANDBOX_NETWORKS` became a closed set in the same change:
 * the moment one server legitimately needs a network, "which network" stops
 * being theoretical, and `host` - which Docker accepts and which would put this
 * container on the box's own stack alongside Postgres and the API - has to be
 * unsayable rather than merely unused.
 *
 * AND THE BODY IS UNTRUSTED. It is a page from a site that just refused a
 * well-behaved client; it is returned as a value and never interpolated into a
 * prompt or a shell by anything here. This file's job ends at "these are the
 * bytes and this was the status".
 */
import type { FetchOutcome, TierImpl } from "./fetchtier.js";
import { callSandboxedTool, type SandboxNetwork } from "./mcp.js";

/**
 * The powhttp MCP server (B8: github.com/usestring/powhttp-mcp).
 *
 * Pinned by digest or tag at deploy time rather than hardcoded here — a fetcher
 * is the one container on this box that talks to the open internet, and "which
 * image is that" should be answerable from the deployment rather than from a
 * constant somebody edited eight months ago.
 */
export type PowhttpServer = {
  image: string;
  command: string[];
  /** The tool the server exposes for a plain GET. */
  tool?: string;
};

/** A fetcher gets egress and nothing else. Not host, not the project volume. */
export const FETCH_NETWORK: SandboxNetwork = "bridge";

/** What the server is expected to hand back. Anything else is not an answer. */
type PowhttpReply = { status?: unknown; body?: unknown; error?: unknown };

/**
 * The tier-2 implementation.
 *
 * `call` is injectable so the mapping below can be tested without a container,
 * which matters more than usual here: the interesting behaviour is entirely in
 * how a reply becomes an escalate-or-stop decision, and a test that needs Docker
 * and the open internet to exercise that is a test that gets skipped.
 */
export function powhttpTier(
  server: PowhttpServer,
  call: (args: {
    image: string;
    command: string[];
    projectDir?: string | null;
    network?: SandboxNetwork;
    tool: string;
    input: Record<string, unknown>;
  }) => Promise<unknown> = callSandboxedTool,
): TierImpl {
  const tool = server.tool ?? "fetch";
  return async (url: string): Promise<FetchOutcome> => {
    let raw: unknown;
    try {
      raw = await call({
        image: server.image,
        command: server.command,
        /*
         * No project directory. Every other sandboxed server here is attached to
         * one project and mounts it read-only; a fetcher has no business reading
         * any of them, and the way to be sure is not to hand it a path.
         */
        projectDir: null,
        network: FETCH_NETWORK,
        tool,
        input: { url },
      });
    } catch (err) {
      /*
       * The container failed, not the site. Retryable, because the rung above
       * might still get the page - but the reason says which of the two happened
       * so that "the fingerprinting client is broken" never reads in the attempt
       * record as "the site refused us".
       */
      return {
        ok: false,
        retryable: true,
        reason: `the fingerprinting client failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const reply = unwrap(raw);
    if (!reply) {
      return {
        ok: false,
        retryable: true,
        reason: "the fingerprinting client returned something that is not a fetch result",
      };
    }
    if (typeof reply.error === "string" && reply.error) {
      return { ok: false, retryable: true, reason: `the fingerprinting client reported: ${reply.error}` };
    }

    const status = typeof reply.status === "number" ? reply.status : null;
    if (status === null) {
      return { ok: false, retryable: true, reason: "the fingerprinting client returned no status" };
    }
    if (status >= 200 && status < 300) {
      /*
       * A 2xx with no body is not a served page. Reporting it as one hands the
       * caller an empty string that looks like a page with nothing on it, and
       * the ladder stops climbing — so this escalates instead.
       */
      if (typeof reply.body !== "string") {
        return { ok: false, retryable: true, reason: `HTTP ${status} with no body` };
      }
      return { ok: true, body: reply.body, status };
    }

    /*
     * The same reading as the plain rung, and deliberately so: 403 and 429 are a
     * site deciding about the CLIENT, which is what the rung above is for; 404
     * and 410 are decisions about the PAGE, and no client changes them. Getting
     * this wrong in the lenient direction sends a browser — the single heavy
     * slot, ADR 007 — to be told 404 more expensively.
     */
    const retryable = status === 403 || status === 429 || status >= 500;
    return { ok: false, retryable, reason: `HTTP ${status}` };
  };
}

/**
 * Get at the reply through whatever the MCP layer wrapped it in.
 *
 * MCP tool results are `{ content: [{ type: "text", text }] }` far more often
 * than they are the object you wanted, and the text is usually JSON. Handled
 * here rather than assumed, and anything unrecognised becomes null rather than a
 * partly-populated object: a reply this cannot read is not a page, and the rung
 * above should be tried.
 */
function unwrap(raw: unknown): PowhttpReply | null {
  if (!raw || typeof raw !== "object") return null;

  const asRecord = raw as Record<string, unknown>;
  if ("status" in asRecord || "body" in asRecord || "error" in asRecord) {
    return asRecord as PowhttpReply;
  }

  const content = asRecord.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object") return parsed as PowhttpReply;
      } catch {
        // Not JSON. The next part might be; a server that answers in prose is
        // not answering this question.
      }
    }
  }
  return null;
}

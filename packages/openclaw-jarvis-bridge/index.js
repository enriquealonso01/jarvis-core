import crypto from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/core";

// OpenClaw loads this file as plain JavaScript. It must stay valid JS — no type
// annotations — or the plugin fails to load and OpenClaw answers WhatsApp DMs
// with its own default agent, which is exactly what this bridge exists to stop.
//
// ADR 001/002: OpenClaw is a pipe, not a mind. It carries messages; Jarvis
// decides. Two hooks are all that takes, and they were read out of OpenClaw's
// own shipped code rather than assumed:
//
//   message_received   every inbound message. Jarvis persists it BEFORE
//                      anything else happens, which is the whole of ADR 001.
//   before_agent_run   returning { outcome: "block" } is how OpenClaw is told
//                      not to answer. This is the real mechanism; an earlier
//                      version of this file invented `onInbound` and
//                      `skipDefaultAgent`, neither of which exists, and was
//                      never loaded so nothing ever said so.
//
// The failure direction is deliberate and matches OpenClaw's own: if the hook
// throws, `builtin-openclaw` logs "before_agent_run hook failed; blocking
// request" and blocks anyway. So a Jarvis that is down means WhatsApp goes
// quiet — never that OpenClaw starts answering for it.

const HMAC_HEADER = "X-Jarvis-Internal";

export function signBody(secret, body) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export async function ingestToJarvis(payload) {
  const url = process.env.JARVIS_INGEST_URL ?? "http://api:8080/internal/inbox/ingest";
  const secret = process.env.INTERNAL_HMAC;
  if (!secret) {
    throw new Error("INTERNAL_HMAC missing — refuse to complete with a model");
  }
  const body = JSON.stringify(payload);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [HMAC_HEADER]: signBody(secret, body),
      // A retried delivery must not become a second inbox event. The id is the
      // channel's own, so a redelivery of the same message reuses it.
      "X-Request-Id": `openclaw-${payload.external_id ?? crypto.randomUUID()}`,
    },
    body,
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

/**
 * Did the channel say somebody else wrote this?
 *
 * WhatsApp marks a forward on the message, and the adapter surfaces it under
 * one of several names depending on version, so all the plausible ones are
 * checked. The bridge only REPORTS what the channel said; Jarvis decides what
 * it means (S37, `splitAuthorship`). Getting this wrong in the permissive
 * direction is the injection the untrusted-content rule exists to prevent.
 */
export function looksForwarded(msg) {
  return Boolean(
    msg?.isForwarded ?? msg?.is_forwarded ?? msg?.forwarded
    ?? msg?.contextInfo?.isForwarded
    ?? (typeof msg?.contextInfo?.forwardingScore === "number"
      && msg.contextInfo.forwardingScore > 0),
  );
}

export function payloadFor(msg) {
  return {
    channel: msg?.channel ?? "whatsapp",
    external_id: msg?.id ?? msg?.messageId,
    sender: msg?.sender ?? msg?.senderId ?? "",
    text: msg?.text ?? msg?.body ?? "",
    is_forward: looksForwarded(msg),
    forwarded_text: msg?.quotedText ?? msg?.forwardedText ?? undefined,
  };
}

/**
 * OpenClaw plugin entry.
 *
 * `api.on(...)`, NOT `api.registerHook(...)`. The loader warns in as many words
 * that a typed hook event registered through `registerHook` "is dispatched by
 * the typed hook runner only; api.registerHook registrations for it are not
 * invoked" — so that version installs cleanly and never fires, which is the
 * worst of the failure modes available here.
 *
 * `definePluginEntry({ id, name, description, register })` is the real shape,
 * read out of OpenClaw's own SDK (`openclaw/plugin-sdk/core`) rather than
 * guessed. `register` is a PROPERTY of a descriptor object; it is not the
 * export. Two earlier shapes were tried and both were called with `undefined`,
 * which is what an invented API looks like from the inside.
 */
export default definePluginEntry({
  id: "jarvis-bridge",
  name: "Jarvis Bridge",
  description: "Hand every inbound message to Jarvis, and stop OpenClaw answering for it.",
  register(api) {
    api.on("message_received", async (event) => {
      const result = await ingestToJarvis(payloadFor(event?.message ?? event));
      if (!result.ok) {
        // Persist-first: if Jarvis did not store it, this must not be treated
        // as handled. Throwing also blocks the agent, which is the safe way to
        // fail — silence rather than an unrecorded answer.
        throw new Error(`jarvis persist failed status=${result.status}`);
      }
    });

    api.on("before_agent_run", async () => ({
      outcome: "block",
      reason: "Jarvis owns this conversation",
    }));
  },
});

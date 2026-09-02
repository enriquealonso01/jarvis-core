import crypto from "node:crypto";

// OpenClaw loads this file as plain JavaScript. It must stay valid JS — no type
// annotations — or the plugin fails to load and OpenClaw answers WhatsApp DMs
// with its own default agent, which is exactly what this bridge exists to stop.

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
    },
    body,
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

/** OpenClaw plugin entry. Never run the default agent on user DMs. */
export default function jarvisBridge() {
  return {
    name: "openclaw-jarvis-bridge",
    async onInbound(msg) {
      /*
       * S37: whether Enrique wrote this, or passed it along.
       *
       * WhatsApp marks a forward on the message itself, and OpenClaw surfaces
       * it under one of several names depending on the adapter version — so all
       * the plausible ones are checked rather than betting on one. Getting this
       * wrong in the permissive direction is the injection the whole rule
       * exists to prevent, so an unrecognised shape falls to "forwarded" only
       * when something actually says so.
       *
       * Jarvis decides what the flag MEANS (see `splitAuthorship`); the bridge
       * only reports what the channel said.
       */
      const forwarded = Boolean(
        msg?.isForwarded ?? msg?.is_forwarded ?? msg?.forwarded
        ?? msg?.contextInfo?.isForwarded
        ?? (typeof msg?.contextInfo?.forwardingScore === "number"
          && msg.contextInfo.forwardingScore > 0),
      );

      const result = await ingestToJarvis({
        channel: msg?.channel ?? "whatsapp",
        external_id: msg?.id,
        sender: msg?.sender ?? "",
        text: msg?.text ?? "",
        is_forward: forwarded,
        // A quoted/forwarded body when the adapter gives one separately.
        forwarded_text: msg?.quotedText ?? msg?.forwardedText ?? undefined,
      });
      if (!result.ok) {
        // Persist-first: if Jarvis did not store it, retry rather than answer.
        const err = new Error(`jarvis persist failed status=${result.status}`);
        err.retry = true;
        throw err;
      }
      return { skipDefaultAgent: true };
    },
  };
}

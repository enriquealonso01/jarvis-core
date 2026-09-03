import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import { looksUnpaired } from "./classify.js";
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

/**
 * Is this a voice note, and where are its bytes?
 *
 * The WhatsApp plugin carries media as some combination of `mediaKind`,
 * `mediaBuffer`, `mediaPath` and `mediaUrl` - all four names are present in its
 * bundle, and which of them reaches this hook cannot be known until a real
 * message arrives, because the channel is not paired yet. So all three carriers
 * are handled and the shape is logged once when media appears: the first voice
 * note Enrique sends will say which is true, in the log, instead of failing
 * silently.
 */
export function audioFrom(msg) {
  const kind = msg?.mediaKind ?? msg?.mediaType ?? msg?.type ?? "";
  const mime = msg?.mediaMime ?? msg?.mimetype ?? msg?.mimeType ?? "";
  const looksAudio = /audio|voice|ptt/i.test(String(kind)) || /^audio\//i.test(String(mime));
  if (!looksAudio) return null;
  return {
    mime: mime || "audio/ogg",
    buffer: msg?.mediaBuffer ?? msg?.buffer ?? null,
    path: msg?.mediaPath ?? msg?.path ?? null,
    url: msg?.mediaUrl ?? (Array.isArray(msg?.mediaUrls) ? msg.mediaUrls[0] : null),
  };
}

async function audioBase64(audio, log) {
  try {
    if (audio.buffer) return Buffer.from(audio.buffer).toString("base64");
    if (audio.path) return (await fsp.readFile(audio.path)).toString("base64");
    if (audio.url) {
      const r = await fetch(audio.url);
      if (!r.ok) throw new Error(`media fetch ${r.status}`);
      return Buffer.from(await r.arrayBuffer()).toString("base64");
    }
  } catch (err) {
    log?.warn?.(`[jarvis-bridge] could not read voice note: ${err.message}`);
  }
  return null;
}

export async function payloadFor(msg, log) {
  const audio = audioFrom(msg);
  if (audio) {
    log?.info?.(`[jarvis-bridge] media message; fields: ${Object.keys(msg ?? {}).join(",")}`);
  }
  const encoded = audio ? await audioBase64(audio, log) : null;
  return {
    channel: msg?.channel ?? "whatsapp",
    external_id: msg?.id ?? msg?.messageId,
    sender: msg?.sender ?? msg?.senderId ?? "",
    text: msg?.text ?? msg?.body ?? "",
    is_forward: looksForwarded(msg),
    forwarded_text: msg?.quotedText ?? msg?.forwardedText ?? undefined,
    // Jarvis stores the audio, transcribes it, and routes the transcript like
    // typed text. The bridge does not transcribe: it is a pipe.
    ...(encoded ? { audio_base64: encoded, audio_mime: audio.mime } : {}),
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
    registerSendRoute(api);

    /*
     * Say so, loudly, on registration and on every fire.
     *
     * Whether these hooks are invoked at all turned out to be the entire
     * question, and it could not be answered from the outside: the plugin
     * loads, `plugins inspect` says hook-only with conversation access, and an
     * agent turn still reached the model. Logging is the only instrument that
     * distinguishes "not registered", "registered but not dispatched on this
     * path", and "dispatched but the return value ignored".
     */
    const log = api.logger ?? console;
    log.info?.("[jarvis-bridge] registering before_dispatch, message_received, before_agent_run");

    /*
     * `before_dispatch` is the hook that matches what this bridge is for.
     *
     * OpenClaw's own hooks.md classifies `message_received` as Observe — it
     * cannot stop OpenClaw answering, so on its own it could never satisfy
     * ADR 002 even if it fired. `inbound_claim` looks right by name and is
     * not: the same doc says it "is not a global pre-routing broadcast" and is
     * invoked only for the plugin owning the message's conversation binding,
     * which this bridge does not own. `before_dispatch` is documented as a
     * Claim — "handle an inbound message before the normal model dispatch",
     * where returning `{ handled: true }` handles it with no text. That is
     * exactly the contract: Jarvis persists it, and OpenClaw says nothing.
     */
    api.on("before_dispatch", async (event) => {
      log.info?.("[jarvis-bridge] before_dispatch fired");
      const result = await ingestToJarvis(await payloadFor(event?.message ?? event, log));
      if (!result.ok) {
        // Persist-first, and fail closed: if Jarvis did not store it, do not
        // claim it as handled. Throwing keeps WhatsApp silent rather than
        // letting OpenClaw answer for an event nothing recorded.
        throw new Error(`jarvis persist failed status=${result.status}`);
      }
      // No text: Jarvis owns the reply and sends it through /jarvis/send.
      return { handled: true };
    });

    /*
     * Kept as an observer only. It is not load-bearing now that
     * `before_dispatch` claims the message, but it is the cheapest witness to
     * whether inbound dispatch reaches this plugin at all.
     */
    api.on("message_received", async () => {
      log.info?.("[jarvis-bridge] message_received fired");
    });

    api.on("before_agent_run", async () => {
      log.info?.("[jarvis-bridge] before_agent_run fired — blocking");
      return { outcome: "block", reason: "Jarvis owns this conversation" };
    });
  },
});

/**
 * The outbound half: one HTTP route Jarvis can post a message to.
 *
 * Jarvis's worker cannot run the OpenClaw CLI — different container, and
 * deliberately no Docker socket — and the gateway speaks WebSocket. The stock
 * `admin-http-rpc` plugin was checked and has no send method (its methods are
 * health, status and agents.*). So the send lives here, inside OpenClaw, where
 * the CLI exists and is a supported interface.
 *
 * `channel.outbound.loadAdapter` is the more native route and is deliberately
 * NOT used yet: its shape is undocumented, it likely requires a paired channel,
 * and three ticks of guessing at internal APIs is enough. The CLI is a stable,
 * documented surface, and swapping to the adapter later changes only this
 * function.
 *
 * Two properties this must have, and they are the reason it is not a one-liner:
 *
 *   authenticated — the same INTERNAL_HMAC the inbound direction uses, so this
 *                   route is no weaker than the one it mirrors.
 *   exactly once  — the outbox marks a row sent only after a success, so a
 *                   crash between the send and the mark would resend on retry.
 *                   The dedupe below closes that window: the same outbox id is
 *                   never sent twice by this process.
 */
const sentIds = new Map();
const SENT_TTL_MS = 24 * 60 * 60 * 1000;

function alreadySent(id) {
  const at = sentIds.get(id);
  if (at === undefined) return false;
  if (Date.now() - at > SENT_TTL_MS) {
    sentIds.delete(id);
    return false;
  }
  return true;
}

export function sendViaCli(args) {
  return new Promise((resolve) => {
    const argv = [
      "message", "send",
      "--channel", args.channel ?? "whatsapp",
      "-t", args.to,
      "-m", args.text,
    ];
    if (args.dryRun) argv.push("--dry-run");
    execFile("openclaw", argv, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        const text = `${err.message} ${String(stderr)}`;
        /*
         * Reported as a FLAG, not left for the caller to find in the text.
         *
         * The worker has to tell "the phone is not paired yet" from "the send
         * failed", because the first must not spend a retry. It first did that
         * by matching on this string - and missed, live, because the detail is
         * truncated and a long notification body pushed the words past the cut.
         * A boolean cannot be truncated.
         */
        resolve({
          ok: false,
          unavailable: looksUnpaired(text),
          detail: `${err.message} ${String(stderr).slice(0, 200)}`.trim(),
        });
        return;
      }
      resolve({ ok: true, unavailable: false, detail: String(stdout).trim().slice(0, 200) });
    });
  });
}

/**
 * Read the raw request body.
 *
 * The HMAC is computed over the exact bytes Jarvis signed, so the body must be
 * verified BEFORE it is parsed - re-serialising a parsed object changes key
 * order and whitespace and the signature stops matching.
 */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function registerSendRoute(api) {
  const log = api.logger ?? console;
  api.registerHttpRoute({
    method: "POST",
    path: "/jarvis/send",
    /*
     * "plugin" means this route authenticates itself, and it does: the same
     * INTERNAL_HMAC the inbound direction uses, so neither direction is weaker
     * than the other. The alternative, "gateway", would gate on the gateway
     * token instead - a second secret to distribute for no gain, since the
     * worker already holds the HMAC. The loader rejects any other value, and
     * rejects a missing one, which is how the first version was caught.
     */
    auth: "plugin",
    /*
     * (req, res), raw Node - NOT a handler that returns { status, body }.
     *
     * This was read out of the gateway rather than assumed, after a version
     * that returned an object hung every request for twenty seconds with no
     * error and no log line. The dispatcher calls `route.handler(req, res)` and
     * only checks whether the result is `false`, which means "not handled, try
     * the next route". Every other return value - including a perfectly formed
     * response object - means "handled", so the gateway stops and nothing is
     * ever written to the socket. The handler must write the response itself.
     */
    handler: async (req, res) => {
      log.info?.(`[jarvis-bridge] send route entered ${req.method} ${req.url}`);
      const reply = (status, payload) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(payload));
        return true;
      };

      const secret = process.env.INTERNAL_HMAC;
      let raw;
      try {
        raw = await readBody(req);
        log.info?.(`[jarvis-bridge] send route read ${raw.length} body bytes`);
      } catch (err) {
        return reply(413, { ok: false, error: String(err.message ?? err) });
      }

      const signature = req.headers[HMAC_HEADER.toLowerCase()];
      if (!secret || !signature || !safeEqualHex(signature, signBody(secret, raw))) {
        return reply(401, { ok: false, error: "hmac" });
      }

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return reply(400, { ok: false, error: "invalid json" });
      }
      if (!body.to || !body.text) {
        return reply(400, { ok: false, error: "to and text are required" });
      }
      // The outbox row id. Without it there is no way to be idempotent, so it
      // is required rather than optional.
      if (!body.id) return reply(400, { ok: false, error: "id is required" });

      if (alreadySent(body.id)) {
        log.info?.(`[jarvis-bridge] send ${body.id} already delivered; not sending again`);
        return reply(200, { ok: true, deduped: true });
      }

      const result = await sendViaCli({
        to: body.to, text: body.text, channel: body.channel, dryRun: Boolean(body.dry_run),
      });
      if (result.ok && !body.dry_run) sentIds.set(body.id, Date.now());
      log.info?.(`[jarvis-bridge] send ${body.id} ok=${result.ok} ${result.detail}`);
      return reply(result.ok ? 200 : 502, {
        ok: result.ok,
        unavailable: result.unavailable === true,
        detail: result.detail,
      });
    },
  });
}

/** Constant-time compare that cannot throw on a wrong-length header. */
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

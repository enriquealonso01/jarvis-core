import crypto from "node:crypto";
import { sitePin } from "./siteconfig.js";

/**
 * ADR 009: the Telnyx webhook is the one endpoint Jarvis exposes publicly
 * besides the console, and it writes into inbox_events. It was accepting
 * unsigned requests from anyone on the internet.
 *
 * Telnyx signs with Ed25519 over `timestamp|rawBody`, sending
 * `telnyx-signature-ed25519` (base64) and `telnyx-timestamp` (unix seconds).
 */

const REPLAY_WINDOW_SECONDS = 300;

export type TelnyxVerdict =
  | { ok: true }
  | { ok: false; reason: string; status: 401 | 400 | 503 };

export function telnyxPublicKey(): string | null {
  // site.yaml first: the signing key is public, so it belongs with the other
  // pinned operator settings rather than behind an SSH session and a container
  // restart. The env var stays as a fallback so nothing already set breaks.
  return sitePin((c) => c.telnyx?.public_key) ?? (process.env.TELNYX_PUBLIC_KEY?.trim() || null);
}

/** Telnyx publishes the key base64-encoded; node needs it as a DER SPKI. */
function ed25519KeyFromBase64(base64: string): crypto.KeyObject {
  const raw = Buffer.from(base64, "base64");
  // 32-byte raw Ed25519 public key → SPKI DER prefix.
  const der = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

export function verifyTelnyxWebhook(args: {
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
  now?: number;
}): TelnyxVerdict {
  const publicKey = telnyxPublicKey();
  if (!publicKey) {
    // Fail closed. Telnyx is not configured yet, so nothing legitimate is
    // calling this endpoint — accepting unsigned traffic would only let a
    // stranger write into the Inbox.
    return { ok: false, reason: "telnyx public key not configured", status: 503 };
  }
  if (!args.signature || !args.timestamp) {
    return { ok: false, reason: "missing signature headers", status: 401 };
  }

  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "bad timestamp", status: 400 };
  }
  const nowSeconds = Math.floor((args.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - ts) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: "timestamp outside the replay window", status: 401 };
  }

  try {
    const signed = Buffer.from(`${args.timestamp}|${args.rawBody}`, "utf8");
    const sig = Buffer.from(args.signature, "base64");
    if (sig.length !== 64) {
      return { ok: false, reason: "bad signature length", status: 401 };
    }
    const valid = crypto.verify(null, signed, ed25519KeyFromBase64(publicKey), sig);
    return valid ? { ok: true } : { ok: false, reason: "signature mismatch", status: 401 };
  } catch {
    return { ok: false, reason: "signature could not be verified", status: 401 };
  }
}

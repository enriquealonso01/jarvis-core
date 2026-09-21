// No OpenClaw imports on purpose: this file is the one piece of the bridge that
// can be tested on a laptop, and the decision it makes is the one that has been
// wrong twice.

/**
 * Does this failure mean "no phone yet" rather than "the send failed"?
 *
 * A named function with the real strings in it, because the distinction decides
 * whether a queued notification spends one of its seven retries, and it has now
 * been wrong twice in two different ways:
 *
 *   before the channel existed   "Channel is unavailable: whatsapp"
 *   after it was configured      "OutboundDeliveryError: No active WhatsApp Web
 *                                 listener (account: default). ... link WhatsApp
 *                                 with: openclaw channels login ..."
 *
 * The second appeared the moment the channel was configured but not yet linked,
 * and nine queued notifications burned through their whole retry budget in one
 * sweep before it was noticed. Both are the same fact - there is no phone on the
 * other end - and neither is a reason to give up on the message.
 *
 * Deliberately NOT matching `OutboundDeliveryError` on its own: that is the
 * generic wrapper for real delivery failures too, and treating those as "not
 * paired" would retry forever instead of surfacing them.
 */
export function looksUnpaired(text) {
  return /channel is unavailable|no active whatsapp|not linked|not connected|no such channel|channels login/i
    .test(String(text));
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

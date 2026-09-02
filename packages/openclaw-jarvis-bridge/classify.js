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

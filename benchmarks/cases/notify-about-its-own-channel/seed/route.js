/**
 * Pick the channel a notification should be delivered over.
 *
 * `channels` is the delivery order, each `{ id, live }`. A channel that is not
 * live cannot deliver anything. The console is always reachable and is the last
 * resort.
 *
 * A notification may be ABOUT a channel - "pair WhatsApp", "your SMS number
 * changed" - and carries that channel's id in `about`.
 */
export function chooseChannel(notification, channels) {
  const live = channels.filter((c) => c.live);
  return live.length ? live[0].id : "console";
}

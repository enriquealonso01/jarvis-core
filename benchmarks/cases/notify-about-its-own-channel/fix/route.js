/**
 * Pick the channel a notification should be delivered over.
 *
 * `channels` is the delivery order, each `{ id, live }`. A channel that is not
 * live cannot deliver anything. The console is always reachable and is the last
 * resort.
 *
 * A notification may be ABOUT a channel - "pair WhatsApp", "your SMS number
 * changed" - and carries that channel's id in `about`.
 *
 * The rule that is easy to miss: a notification about a channel must not be
 * delivered over that channel, whether or not it is live. Checking liveness
 * alone happens to route the reported case correctly and still sends "your
 * WhatsApp link is broken" over WhatsApp the moment the link comes back.
 *
 * And excluding it can empty the list, so the console fallback matters more
 * here than anywhere else: the notification explaining how to fix an outage is
 * exactly the one that must not be lost to it.
 */
export function chooseChannel(notification, channels) {
  const usable = channels.filter((c) => c.live && c.id !== notification.about);
  return usable.length ? usable[0].id : "console";
}

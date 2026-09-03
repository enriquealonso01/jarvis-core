import test from "node:test";
import assert from "node:assert/strict";
import { chooseChannel } from "../src/route.js";

const CHANNELS = (whatsapp, phone) => [
  { id: "whatsapp", live: whatsapp },
  { id: "phone", live: phone },
];

// The reported case: telling someone to pair WhatsApp, over WhatsApp.
test("a notification about a channel never goes over that channel", () => {
  const to = chooseChannel({ kind: "pairing", about: "whatsapp" }, CHANNELS(false, true));
  assert.equal(to, "phone");
});

/*
 * The same rule when the channel IS live. The bug looks like "do not use a dead
 * channel", and a fix that only checks liveness passes the case above by
 * accident while still sending "your WhatsApp link is broken" over WhatsApp.
 */
test("even when that channel is live", () => {
  const to = chooseChannel({ kind: "pairing", about: "whatsapp" }, CHANNELS(true, true));
  assert.equal(to, "phone");
});

// What the seed already did right, and an over-eager fix breaks.
test("an ordinary notification still takes the first live channel", () => {
  const to = chooseChannel({ kind: "task_done" }, CHANNELS(true, true));
  assert.equal(to, "whatsapp");
});

test("and never a dead one", () => {
  const to = chooseChannel({ kind: "task_done" }, CHANNELS(false, true));
  assert.equal(to, "phone");
});

/*
 * The last resort has to survive the new rule. Excluding the channel a
 * notification is about can empty the list, and returning nothing there means
 * the one notification telling someone how to fix the outage is the one that
 * never arrives.
 */
test("when the rule leaves nothing, the console still gets it", () => {
  const to = chooseChannel({ kind: "pairing", about: "whatsapp" }, CHANNELS(true, false));
  assert.equal(to, "console");
});

test("and with no channels at all", () => {
  assert.equal(chooseChannel({ kind: "task_done" }, []), "console");
});

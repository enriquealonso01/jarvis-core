import { test } from "node:test";
import assert from "node:assert/strict";
import { looksUnpaired } from "../packages/openclaw-jarvis-bridge/classify.js";

/*
 * The two real strings, copied from the box, and the failures that must NOT be
 * mistaken for them. This exists because the classification was wrong twice and
 * each time it silently spent a queued notification's retry budget.
 */
const UNPAIRED = [
  "Command failed: openclaw message send --channel whatsapp\nChannel is unavailable: whatsapp",
  "OutboundDeliveryError: No active WhatsApp Web listener (account: default)."
    + " Start the gateway, then link WhatsApp with: openclaw channels login --channel whatsapp --account default.",
];

const REAL_FAILURES = [
  "OutboundDeliveryError: recipient +13055052646 is not on WhatsApp",
  "OutboundDeliveryError: message too long",
  "Command failed: openclaw message send\nrate limited, try again later",
  "Error: ENOENT: no such file or directory",
];

test("both flavours of not-yet-paired are recognised", () => {
  for (const t of UNPAIRED) assert.ok(looksUnpaired(t), `should defer: ${t.slice(0, 60)}`);
});

test("a real delivery failure is not treated as unpaired", () => {
  for (const t of REAL_FAILURES) assert.ok(!looksUnpaired(t), `should NOT defer: ${t.slice(0, 60)}`);
});

test("the generic error wrapper alone does not mean unpaired", () => {
  assert.ok(!looksUnpaired("OutboundDeliveryError: something went wrong"));
});

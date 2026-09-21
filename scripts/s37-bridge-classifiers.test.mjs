import { test } from "node:test";
import assert from "node:assert/strict";
import { audioFrom, looksForwarded } from "../packages/openclaw-jarvis-bridge/classify.js";

/*
 * These two classifiers moved here from index.js (which imports the OpenClaw
 * SDK and so cannot be imported on a laptop). Same story as
 * s37-bridge-classify.test.mjs: the decision is the part that has been wrong,
 * so it gets the strings in a test, not just in comments.
 */

test("forward is recognised under every alias the adapter has used", () => {
  const positive = [
    { isForwarded: true },
    { is_forwarded: true },
    { forwarded: true },
    { contextInfo: { isForwarded: true } },
    { contextInfo: { forwardingScore: 3 } },
  ];
  for (const msg of positive) assert.ok(looksForwarded(msg), JSON.stringify(msg));
});

test("a forwardingScore of 0 is not a forward", () => {
  assert.ok(!looksForwarded({ contextInfo: { forwardingScore: 0 } }));
});

test("plain messages are not forwards", () => {
  for (const msg of [{}, null, { text: "hello" }]) {
    assert.ok(!looksForwarded(msg), JSON.stringify(msg));
  }
});

test("voice note carriers are all read", () => {
  const bufferMsg = { mediaKind: "audio", mediaMime: "audio/ogg", mediaBuffer: Buffer.from([1]) };
  assert.equal(audioFrom(bufferMsg).buffer, bufferMsg.mediaBuffer);
  const pathMsg = { mediaType: "ptt", mediaPath: "/tmp/note.ogg" };
  assert.equal(audioFrom(pathMsg).path, "/tmp/note.ogg");
  const urlMsg = { type: "audio", mediaUrl: "https://example.com/n.ogg" };
  assert.equal(audioFrom(urlMsg).url, "https://example.com/n.ogg");
  const urlsMsg = { type: "audio", mediaUrls: ["https://example.com/a.ogg", "https://example.com/b.ogg"] };
  assert.equal(audioFrom(urlsMsg).url, "https://example.com/a.ogg");
});

test("a voice note with no mime falls back to audio/ogg", () => {
  assert.equal(audioFrom({ mediaKind: "audio" }).mime, "audio/ogg");
});

test("text messages produce no audio", () => {
  for (const msg of [{}, null, { text: "hello" }, { mediaKind: "image", mediaMime: "image/png" }]) {
    assert.equal(audioFrom(msg), null, JSON.stringify(msg));
  }
});

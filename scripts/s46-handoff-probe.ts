/**
 * Adversarial probe of the auth handoff (S46).
 *
 * The file's own framing: "an auth link is the exact shape a phishing attempt
 * would want Jarvis to deliver". So this probe tries to be that attempt.
 */
import {
  mintAuthLink, handoffFor, handoffMessage, linkIsFresh,
  type RequestOrigin, type AuthLink,
} from "../src/handoff.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};
const refuses = (name: string, authorizeUrl: string) => {
  try {
    const l = mintAuthLink({ provider: "google", authorizeUrl, lifetimeMs: 600_000 });
    ok(name, false, `minted ${l.url}`);
  } catch { ok(name, true); }
};

console.log("\n== only https may become a link he taps ==");
for (const u of [
  "http://accounts.google.com/o/oauth2/auth",
  "javascript:alert(document.cookie)",
  "data:text/html,<form action=https://evil>",
  "file:///etc/passwd",
  "ftp://evil.com/",
  "ws://evil.com/",
  "vbscript:msgbox",
]) refuses(`refuses ${u.slice(0, 42)}`, u);

const good = mintAuthLink({
  provider: "google", authorizeUrl: "https://accounts.google.com/o/oauth2/auth?c=1", lifetimeMs: 600_000,
});
ok("mints an https link", good.url.startsWith("https://accounts.google.com/"));
ok("provenance is the only value", good.provenance === "connection_flow");
ok("uppercase scheme is still https", mintAuthLink({
  provider: "g", authorizeUrl: "HTTPS://accounts.google.com/x", lifetimeMs: 1,
}).url.startsWith("https://"));

console.log("\n== the userinfo swap ==");
// The classic phishing URL: reads as google, resolves to evil.com.
// brevity.ts:170 already refuses this shape for a mere DOCUMENT link.
for (const u of [
  "https://accounts.google.com@evil.com/signin",
  "https://user:pw@evil.com/signin",
  "https://accounts.google.com%40evil.com@evil.com/",
]) refuses(`refuses ${u.slice(0, 46)}`, u);

console.log("\n== the message tells the truth about the host ==");
const swapped = (() => {
  try {
    return mintAuthLink({ provider: "google", authorizeUrl: "https://accounts.google.com@evil.com/s", lifetimeMs: 1000 });
  } catch { return null; }
})();
if (swapped) {
  const msg = handoffMessage(swapped);
  ok("if it mints at all, the message still names the REAL host",
    msg.includes("opens evil.com"), msg.replace(/\n/g, " | "));
} else {
  ok("never mints, so there is no message to check", true);
}
const m = handoffMessage(good, "/connections/google");
ok("message names the provider", m.includes("google needs you to sign in"));
ok("message names the real host", m.includes("opens accounts.google.com"));
ok("message carries the console path", m.includes("/connections/google"));

console.log("\n== origin is the whole gate ==");
const asLink = good;
for (const origin of ["enrique", "approved_task"] as RequestOrigin[]) {
  ok(`${origin} may produce a handoff`, handoffFor({ origin, link: asLink }).send === true);
}
for (const origin of ["message_content", "tool_result"] as RequestOrigin[]) {
  const d = handoffFor({ origin, link: asLink });
  ok(`${origin} becomes content, not a message`, d.send === false && (d as any).asContent === true);
}
console.log("  -- runtime values the type forbids --");
for (const junk of ["constructor", "__proto__", "toString", "ENRIQUE", "enrique ", "", "hasOwnProperty"]) {
  const d = handoffFor({ origin: junk as RequestOrigin, link: asLink });
  ok(`${JSON.stringify(junk)} does not produce a handoff`, d.send === false, JSON.stringify(d));
}

console.log("\n== freshness ==");
const now = new Date("2026-09-03T12:00:00Z");
const l = mintAuthLink({ provider: "g", authorizeUrl: "https://x.example/a", lifetimeMs: 60_000 }, now);
ok("fresh while it lives", linkIsFresh(l, new Date(now.getTime() + 59_000)));
ok("dead at expiry", !linkIsFresh(l, new Date(now.getTime() + 60_000)));
ok("dead after expiry", !linkIsFresh(l, new Date(now.getTime() + 61_000)));

console.log(`==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);

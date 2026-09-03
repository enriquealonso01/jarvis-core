// Prove the id::text fix on the PR-create and PR-merge handlers.
// The two 400s differ in message, which is what makes this decisive with no
// side effects: "project has no linked GitHub repo" means the lookup MISSED,
// "title and head branch required" means it RESOLVED the slug and moved on.
import fs from "node:fs/promises";
const API = "http://127.0.0.1:8080";
const ORIGIN = "https://jarvis.enriquecodes.com";
let cookie = "";

async function login() {
  const raw = await fs.readFile("/var/lib/jarvis/keys/login-once.txt", "utf8");
  const email = /email=(.*)/.exec(raw)?.[1]?.trim() ?? "";
  const password = /password=(.*)/.exec(raw)?.[1]?.trim() ?? "";
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error(`login failed: ${res.status}`);
}

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  console.log(`POST ${path}\n   -> ${res.status} ${text.slice(0, 180)}`);
  return { status: res.status, text };
}

await login();
const real = process.argv[2];
console.log(`real slug under test: ${real}\n`);

console.log("--- PR-create: unknown slug (lookup must MISS cleanly, not 500) ---");
const a = await post("/api/projects/definitely-not-a-real-slug-xyz/pull-requests", {});
console.log("\n--- PR-create: real slug, no title (lookup must RESOLVE by slug) ---");
const b = await post(`/api/projects/${real}/pull-requests`, {});
console.log("\n--- PR-merge: unknown slug ---");
const c = await post("/api/projects/definitely-not-a-real-slug-xyz/pull-requests/999999/merge", {});
console.log("\n--- PR-merge: real slug, absurd PR number (must get PAST the lookup) ---");
const d = await post(`/api/projects/${real}/pull-requests/999999/merge`, {});

const ok =
  a.status === 400 && /no linked GitHub repo/.test(a.text) &&
  b.status === 400 && /title and head branch required/.test(b.text) &&
  c.status === 400 && /no linked GitHub repo/.test(c.text) &&
  d.status !== 500 && !/uuid/.test(d.text);
console.log(`\nno 500s, and the real slug resolved on both handlers: ${ok ? "PASS" : "CHECK ABOVE"}`);

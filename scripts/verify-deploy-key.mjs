import fs from "node:fs/promises";
const API = process.env.JARVIS_API ?? "http://127.0.0.1:8080";
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
  if (!cookie) throw new Error(`could not log in: ${res.status}`);
  console.log("login: ok");
}

async function deployKey(idOrSlug) {
  const res = await fetch(`${API}/api/projects/${idOrSlug}/deploy-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
    body: "{}",
  });
  const text = await res.text();
  console.log(`POST /api/projects/${idOrSlug}/deploy-key -> ${res.status}`);
  console.log(`   ${text.slice(0, 300)}`);
  return res.status;
}

await login();
console.log("\n--- probe 1: nonexistent slug (was 500, must now be 404) ---");
const a = await deployKey("definitely-not-a-real-slug-xyz");
console.log("\n--- probe 2: real slug, the happy path ---");
const b = await deployKey("jarvis-proof-01");
console.log(`\nRESULT nonexistent=${a} real=${b}`);
console.log(a === 404 && b === 200 ? "PASS" : "CHECK ABOVE");

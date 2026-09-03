// End-to-end front-door proof, run ON THE BOX.
// Onboards a brand-new repo through the API path ONLY - no bench helpers, no
// manual patches - then sends a plain-English request and waits for a real PR.
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

async function call(path, body, method = "POST") {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

const tag = Math.random().toString(36).slice(2, 8);
const slug = `jarvis-e2e-${tag}`;
await login();
console.log("login: ok");

console.log("\n[1] create repo through the API");
const repo = await call("/api/github/admin/create-repo", { name: slug });
console.log(`  -> ${repo.status} ${JSON.stringify(repo.json).slice(0, 200)}`);
if (repo.status !== 200) process.exit(1);
const owner = repo.json.owner, repoName = repo.json.name;

console.log("\n[2] create project through the API");
const proj = await call("/api/projects", { slug, name: `e2e ${tag}`, project_type: "personal" });
console.log(`  -> ${proj.status} id=${proj.json?.project?.id}`);
if (proj.status !== 200) process.exit(1);
const pid = proj.json.project.id;

console.log("\n[3] link repo: deploy key + project api credential");
const key = await call(`/api/projects/${slug}/deploy-key`, { owner, repo: repoName });
console.log(`  -> ${key.status} ${JSON.stringify(key.json).slice(0, 220)}`);
if (key.status !== 200) process.exit(1);
console.log(`  apiCredentialId present: ${Boolean(key.json.apiCredentialId)}`);

console.log("\n[4] plain-English request through /api/inbox");
const ask = `#${slug} This new repo is empty. Please add a small money.js that rounds a ` +
  `cent amount correctly, and a test proving 0.615 rounds to 0.62 rather than 0.61. ` +
  `Open a pull request when the test passes.`;
const inbox = await call("/api/inbox", { body: ask });
console.log(`  -> ${inbox.status} ${JSON.stringify(inbox.json).slice(0, 220)}`);

console.log(`\nSLUG=${slug}\nPROJECT_ID=${pid}\nREPO=${owner}/${repoName}`);
console.log("Onboarded with no manual patching. Poll for the task and the PR next.");

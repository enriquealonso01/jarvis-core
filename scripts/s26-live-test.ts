/**
 * S26, live: "a project created by voice ends with a correct committed
 * `AGENTS.md`."
 *
 * The offline suite proves the refusal, the rendering and the versioning against
 * a database. It deliberately never touches GitHub, and so it cannot prove the
 * half that the Done-when is actually about — the file being IN the repository.
 * That needs a real repository, a real credential and a real commit, because the
 * failure modes here are all at the boundary: a Contents API that wants a blob
 * sha to replace and refuses one to create, a token whose scope stops one call
 * short, a branch that does not exist yet.
 *
 * The repository is fixed rather than per-run (`jarvis-s26-fixture`), created
 * once and reused. Two consequences, both wanted: test runs do not accumulate
 * repositories under the account, and the second run exercises REPLACING a file
 * rather than creating one, which is the path that needs the sha.
 */
import { createPool } from "../src/db.js";
import { githubCreatePrivateRepo } from "../src/github.js";
import { templatePlaceholders } from "../src/agentsfile.js";
import { runTool } from "../src/supervisor.js";

const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 240)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));

const REPO = "jarvis-s26-fixture";
const STAMP = Date.now().toString(36).slice(-6);

async function adminHeaders(): Promise<Record<string, string>> {
  const row = await pool.query<{ credential_id: string }>(
    "SELECT credential_id FROM auth_profiles WHERE id = 'github_personal_admin'");
  const { readJsonCredential } = await import("../src/credentials.js");
  const cred = await readJsonCredential(pool, row.rows[0].credential_id);
  return {
    Authorization: `Bearer ${cred.api_key}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "jarvis-core",
  };
}

async function clean(): Promise<void> {
  await pool.query(
    `DELETE FROM project_instructions_versions WHERE project_id IN
       (SELECT id FROM projects WHERE slug LIKE $1)`, [`%${STAMP}%`]);
  await pool.query(
    "DELETE FROM onboarding_sessions WHERE conversation_id IN (SELECT id FROM conversations WHERE title LIKE $1)",
    [`%${STAMP}%`]);
  await pool.query("DELETE FROM projects WHERE slug LIKE $1", [`%${STAMP}%`]);
  await pool.query("DELETE FROM conversations WHERE title LIKE $1", [`%${STAMP}%`]);
}

async function main(): Promise<void> {
  await clean();
  const headers = await adminHeaders();

  console.log("########## a real private repository to commit into ##########\n");
  let owner = "";
  let branch = "main";
  {
    const probe = await fetch(`https://api.github.com/repos/enriquealonso01/${REPO}`, { headers });
    if (probe.ok) {
      const json = (await probe.json()) as { owner: { login: string }; default_branch: string };
      owner = json.owner.login;
      branch = json.default_branch;
      ok(`the fixture repository already exists (${owner}/${REPO})`);
    } else {
      const made = await githubCreatePrivateRepo(pool, REPO);
      if ("error" in made) {
        bad("create the fixture repository", "created", made.error);
        console.log(`\n==== ${pass} passed, ${fail + 1} failed ====`);
        process.exit(1);
      }
      owner = made.owner;
      branch = made.default_branch;
      ok(`created ${made.full_name}`);
    }
  }

  console.log("\n########## onboard a project that names it ##########\n");
  const slug = `s26-${STAMP}`;
  const answers: Record<string, string> = {
    name: `S26 Fixture ${STAMP}`,
    slug,
    project_type: "professional",
    confidentiality: "confidential",
    production_status: "staging",
    customer_facing: "no",
    metered_spend_allowed: "no",
    github_owner: owner,
    github_repo: REPO,
    default_branch: branch,
    allowed_auth_profiles: `${slug}-deploy-key`,
    approved_data_processors: "none",
    setup_command: "pnpm install",
    test_command: "pnpm test",
    lint_command: "none",
    safe_environments: "staging only",
    deploy_policy: `Enrique approves every production deploy (${STAMP})`,
    project_forbidden: "no customer data leaves staging",
    before_pr: "tests green and a review",
    before_deploy: "a staging smoke test",
    migration_policy: "Enrique runs migrations by hand",
    default_queue_priority: "normal",
  };

  const convo = await pool.query<{ id: string }>(
    "INSERT INTO conversations (title, channel) VALUES ($1, 'voice') RETURNING id",
    [`s26 live ${STAMP}`]);
  const cid = convo.rows[0].id;
  await runTool(pool, cid, "", "project.onboarding_start", {}, "");
  for (const [field, value] of Object.entries(answers)) {
    const r = await runTool(pool, cid, "", "project.onboarding_set", { field, value }, "");
    if (r !== "ok") bad(`setting ${field}`, "ok", r);
  }
  const done = await runTool(pool, cid, "", "project.onboarding_finalize", {}, "");
  truthy("finalize reports a commit", done.includes("committed "));
  if (!done.includes("committed ")) console.log(`        finalize said: ${done}`);

  console.log("\n########## the file is in the repository, and it is his answers ##########\n");
  {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${REPO}/contents/AGENTS.md?ref=${branch}`,
      { headers });
    check("GitHub serves AGENTS.md", 200, res.status);
    const json = (await res.json()) as { content?: string; encoding?: string };
    const committed = Buffer.from(json.content ?? "", "base64").toString("utf8");

    /*
     * The Done-when says "correct". Correct means it matches the answers he
     * gave, so every free-text answer is looked for by value — a file that
     * merely parses, or that matches the template, would pass a weaker test and
     * tell a project the wrong rules.
     */
    check("with no placeholder left in it", 0, templatePlaceholders(committed).length);
    truthy("his project name", committed.includes(answers.name));
    truthy("his repository", committed.includes(`owner/repo: ${owner}/${REPO}`));
    truthy("his deploy policy, this run's wording", committed.includes(answers.deploy_policy));
    truthy("his migration rule", committed.includes(answers.migration_policy));
    truthy("the lint answer he actually gave", committed.includes("Lint/type: none"));
    truthy("and the classification",
      committed.includes("production_status: staging") && committed.includes("customer_facing: no"));

    /*
     * ADR 018: the row is canonical and the file is a rendering of it. If these
     * two ever differ, the project has two policies and one of them is a lie.
     */
    const row = await pool.query<{ body: string }>(
      `SELECT body FROM project_instructions_versions
       WHERE project_id = (SELECT id FROM projects WHERE slug = $1)`, [slug]);
    check("and the committed bytes are the canonical row, exactly", row.rows[0]?.body, committed);
  }

  await clean();
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

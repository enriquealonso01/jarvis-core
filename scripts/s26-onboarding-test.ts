/**
 * S26 — project onboarding and `AGENTS.md`.
 *
 * The step's own Debug section names the failure this suite exists to prevent:
 * "If `AGENTS.md` lands with template placeholders still in it, finalize ran
 * before every answer was collected — the onboarding session must refuse to
 * finalize on a missing required field rather than substituting a default."
 *
 * So the assertions that matter are the negative ones. Rendering a complete set
 * of answers is easy and proves little; refusing an incomplete set, naming what
 * is missing, and creating NOTHING is the whole behaviour. A project row with an
 * AGENTS.md full of braces is worse than no project, because every engineering
 * task in it will read those braces as instructions.
 */
import fs from "node:fs";
import { createPool } from "../src/db.js";
import {
  AGENTS_TEMPLATE, renderAgentsMd, templateFromDoc, templatePlaceholders,
} from "../src/agentsfile.js";
import { ONBOARDING_FIELDS } from "../src/policy.js";
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

const STAMP = Date.now().toString(36).slice(-6);

/** Every answer a complete onboarding collects. */
const COMPLETE: Record<string, string> = {
  name: `Acme Store ${STAMP}`,
  slug: `acme-${STAMP}`,
  project_type: "professional",
  confidentiality: "confidential",
  production_status: "production",
  customer_facing: "yes",
  metered_spend_allowed: "no",
  github_owner: "enriquealonso01",
  github_repo: `acme-${STAMP}`,
  default_branch: "main",
  allowed_auth_profiles: "acme-github-deploy, acme-openai",
  approved_data_processors: "none",
  setup_command: "pnpm install",
  test_command: "pnpm test",
  lint_command: "pnpm lint",
  safe_environments: "staging",
  deploy_policy: "Enrique approves every production deploy",
  project_forbidden: "no customer PII in logs",
  before_pr: "tests and lint green",
  before_deploy: "staging smoke test",
  migration_policy: "reviewed by Enrique before it runs",
  default_queue_priority: "normal",
};

async function clean(): Promise<void> {
  await pool.query(
    `DELETE FROM project_instructions_versions WHERE project_id IN
       (SELECT id FROM projects WHERE slug LIKE $1)`, [`%${STAMP}%`]);
  await pool.query("DELETE FROM onboarding_sessions WHERE conversation_id IN (SELECT id FROM conversations WHERE title LIKE $1)", [`%${STAMP}%`]);
  await pool.query("DELETE FROM audit_events WHERE target LIKE $1", [`%${STAMP}%`]);
  await pool.query("DELETE FROM projects WHERE slug LIKE $1", [`%${STAMP}%`]);
  await pool.query("DELETE FROM conversations WHERE title LIKE $1", [`%${STAMP}%`]);
}

async function newConversation(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    "INSERT INTO conversations (title, channel) VALUES ($1, 'console') RETURNING id",
    [`onboarding ${STAMP}`]);
  return r.rows[0].id;
}

async function main(): Promise<void> {
  await clean();

  console.log("########## the template in code and the template in the doc ##########\n");
  {
    const doc = fs.readFileSync(new URL("../docs/TEMPLATES.md", import.meta.url), "utf8");
    const fromDoc = templateFromDoc(doc);
    truthy("the doc still has a fenced AGENTS.md block", fromDoc);
    /*
     * Two copies of a template drift. The production image ships `src` and not
     * `docs`, so the constant is what a project actually gets; this is the only
     * thing stopping the document people read from describing something else.
     */
    check("and it is byte-identical to AGENTS_TEMPLATE", AGENTS_TEMPLATE, fromDoc);

    const placeholders = [...new Set(templatePlaceholders())];
    const fields = new Set<string>(ONBOARDING_FIELDS as readonly string[]);
    // `project_name` is answered by the `name` field; everything else is 1:1.
    const unanswerable = placeholders.filter((p) => p !== "project_name" && !fields.has(p));
    check("every placeholder has an onboarding field that fills it", 0, unanswerable.length);
    if (unanswerable.length) console.log(`        orphans: ${unanswerable.join(", ")}`);
  }

  console.log("\n########## an incomplete answer set renders nothing ##########\n");
  {
    for (const drop of ["test_command", "deploy_policy", "github_repo"]) {
      const answers = { ...COMPLETE, project_name: COMPLETE.name } as Record<string, string>;
      delete answers[drop];
      const r = renderAgentsMd(answers);
      check(`dropping ${drop} refuses to render`, false, r.ok);
      truthy(`...and says which one`, !r.ok && r.missing.includes(drop));
    }

    // Whitespace is not an answer, and "none" is.
    const blank = { ...COMPLETE, project_name: COMPLETE.name, lint_command: "   " };
    const blankResult = renderAgentsMd(blank);
    check("a whitespace answer is still unanswered", false, blankResult.ok);

    const none = { ...COMPLETE, project_name: COMPLETE.name, lint_command: "none" };
    const noneResult = renderAgentsMd(none);
    check("but 'none' is a real answer", true, noneResult.ok);
    truthy("and reaches the file", noneResult.ok && noneResult.body.includes("Lint/type: none"));
  }

  console.log("\n########## a complete set renders a file with no braces left ##########\n");
  {
    const r = renderAgentsMd({ ...COMPLETE, project_name: COMPLETE.name } as never);
    truthy("it renders", r.ok);
    if (r.ok) {
      check("with no placeholder anywhere", 0, templatePlaceholders(r.body).length);
      check("no stray braces either", false, r.body.includes("{{"));
      truthy("the name is the one he gave", r.body.startsWith(`# Agent instructions — ${COMPLETE.name}`));
      truthy("the repo is the one he gave",
        r.body.includes(`owner/repo: ${COMPLETE.github_owner}/${COMPLETE.github_repo}`));
      truthy("and the deploy policy is his sentence, not a default",
        r.body.includes(COMPLETE.deploy_policy));
    }
  }

  console.log("\n########## finalize refuses, and creates nothing ##########\n");
  {
    const convo = await newConversation();
    await runTool(pool, convo, "", "project.onboarding_start", {}, "");
    /*
     * Everything except the one question nobody asked — and with no repository,
     * so this suite never reaches out to GitHub. The committing half is a
     * separate live test against a real repo, because a mock of the Contents
     * API would prove only that the mock agrees with itself.
     */
    for (const [field, value] of Object.entries({ ...COMPLETE, github_owner: "none", github_repo: "none" })) {
      if (field === "before_deploy") continue;
      await runTool(pool, convo, "", "project.onboarding_set", { field, value }, "");
    }

    const refusal = await runTool(pool, convo, "", "project.onboarding_finalize", {}, "");
    truthy("finalize refuses", refusal.includes("still unanswered"));
    truthy("naming the question that was never asked", refusal.includes("before_deploy"));
    truthy("and telling the Supervisor to ask rather than fill it in",
      refusal.includes("do not fill them in"));

    const projects = await pool.query("SELECT id FROM projects WHERE slug = $1", [COMPLETE.slug]);
    check("no project row was created", 0, projects.rowCount);
    const sess = await pool.query<{ status: string }>(
      "SELECT status FROM onboarding_sessions WHERE conversation_id = $1", [convo]);
    check("and the session is still open, so the answers survive", "in_progress", sess.rows[0]?.status);
  }

  console.log("\n########## answer the last question and it goes through ##########\n");
  {
    const convo = await pool.query<{ id: string }>(
      "SELECT conversation_id AS id FROM onboarding_sessions WHERE status = 'in_progress' ORDER BY created_at DESC LIMIT 1");
    const cid = convo.rows[0].id;
    await runTool(pool, cid, "", "project.onboarding_set",
      { field: "before_deploy", value: COMPLETE.before_deploy }, "");
    const done = await runTool(pool, cid, "", "project.onboarding_finalize", {}, "");
    truthy("finalize succeeds", done.includes("project_id"));
    /*
     * "none" is an answer to the repository question too. The instructions still
     * exist and are still canonical; there is simply nowhere to commit them, and
     * saying so is different from claiming a commit that never happened.
     */
    truthy("and says the instructions are stored with no repository to commit to",
      done.includes("stored (no repository)"));

    const row = await pool.query<{ id: string; project_type: string; confidentiality: string }>(
      "SELECT id, project_type, confidentiality FROM projects WHERE slug = $1", [COMPLETE.slug]);
    check("the project exists", 1, row.rowCount);
    check("as professional", "professional", row.rows[0]?.project_type);
    check("and confidential", "confidential", row.rows[0]?.confidentiality);

    const version = await pool.query<{ version: number; body: string; created_by: string }>(
      "SELECT version, body, created_by FROM project_instructions_versions WHERE project_id = $1",
      [row.rows[0].id]);
    check("the instructions are versioned", 1, version.rowCount);
    check("as version 1", 1, version.rows[0]?.version);
    check("written by jarvis", "jarvis", version.rows[0]?.created_by);

    /*
     * The Done-when in miniature: the stored instructions must match the
     * answers, not a template. Checked field by field against what was said.
     */
    const body = version.rows[0]?.body ?? "";
    check("no placeholder survived into the stored body", 0, templatePlaceholders(body).length);
    truthy("it carries his project name", body.includes(COMPLETE.name));
    // This flow answered "none" to the repository question, and the file says so
    // rather than inventing one. The real owner/repo case is asserted above,
    // against the renderer, and again live.
    truthy("the repository he actually named", body.includes("owner/repo: none/none"));
    truthy("his auth profiles", body.includes(COMPLETE.allowed_auth_profiles));
    truthy("his test command", body.includes(COMPLETE.test_command));
    truthy("his deploy policy", body.includes(COMPLETE.deploy_policy));
    truthy("his migration rule", body.includes(COMPLETE.migration_policy));
    truthy("and the classification he chose",
      body.includes("production_status: production") && body.includes("customer_facing: yes"));
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

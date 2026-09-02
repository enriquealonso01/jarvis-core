/**
 * S27 — configuration by conversation.
 *
 * The step's Done-when is three claims about one sentence: it "changes a
 * different project's behaviour, is auditable a week later, and can be rolled
 * back". Each is asserted against the database rather than against a return
 * value, because a function that reports success and writes nothing is exactly
 * the bug the step's Debug section is about.
 *
 * The refusals get more attention than the changes. "A half-applied config
 * change is worse than none" is the sentence the whole step turns on: an
 * instruction that is refused must leave NOTHING behind — no version, no
 * partial write, no altered project — and an instruction that is ambiguous must
 * not even record an attempt, because a question that has not been answered is
 * not a change that failed.
 */
import fs from "node:fs";
import { createPool } from "../src/db.js";
import {
  IMMUTABLE_DOMAINS, IMMUTABLE_KEYS, applyConfigChange, applyInstructionsChange,
  configHistory, immutableDomain, rollbackConfig, rollbackInstructions,
} from "../src/config.js";

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

async function clean(): Promise<void> {
  for (const sql of [
    `DELETE FROM config_versions WHERE project_id IN (SELECT id FROM projects WHERE slug LIKE $1)`,
    `DELETE FROM config_versions WHERE key LIKE $1`,
    `DELETE FROM project_instructions_versions WHERE project_id IN (SELECT id FROM projects WHERE slug LIKE $1)`,
    `DELETE FROM audit_events WHERE project_id IN (SELECT id FROM projects WHERE slug LIKE $1)`,
    // The immutable-list refusals raise approvals against the project, and their
    // dedupe keys are built from the key and conversation rather than the stamp.
    `DELETE FROM issues WHERE project_id IN (SELECT id FROM projects WHERE slug LIKE $1)`,
    `DELETE FROM issues WHERE dedupe_key LIKE $1`,
    `DELETE FROM onboarding_sessions WHERE project_id IN (SELECT id FROM projects WHERE slug LIKE $1)`,
    // Conversations are scoped to a project, so they go before it.
    `DELETE FROM conversations WHERE title LIKE $1`,
    `DELETE FROM projects WHERE slug LIKE $1`,
  ]) await pool.query(sql, [`%${STAMP}%`]);
}

async function main(): Promise<void> {
  await clean();

  // Two projects, because the point of the step is that a sentence said in one
  // place changes a project he is NOT currently talking about.
  const alpha = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, is_system, project_type, confidentiality)
     VALUES ($1, $2, false, 'professional', 'normal') RETURNING id`,
    [`alpha-${STAMP}`, `Alpha ${STAMP}`])).rows[0].id;
  const beta = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, is_system, project_type, confidentiality)
     VALUES ($1, $2, false, 'personal', 'normal') RETURNING id`,
    [`beta-${STAMP}`, `Beta ${STAMP}`])).rows[0].id;
  // A conversation scoped to Beta. Everything below is said HERE and lands THERE.
  const convo = (await pool.query<{ id: string }>(
    `INSERT INTO conversations (title, channel, project_id) VALUES ($1, 'voice', $2) RETURNING id`,
    [`talking about beta ${STAMP}`, beta])).rows[0].id;

  console.log("########## there is exactly one writer ##########\n");
  {
    /*
     * The step's Debug section, made mechanical:
     *
     *   "If a change applies but does not show in history, the write is
     *    bypassing the versioning path. Every config write goes through one
     *    function; find the one that does not."
     *
     * Every assertion elsewhere in this suite tests the function. None of them
     * can see a second writer somewhere else in the tree — a route that INSERTs
     * straight into the table applies a change that is invisible to history, and
     * every test here would still be green.
     *
     * So this reads the source. When it was first written it found two:
     * `product.ts` (the schedule route) and `supervisor.ts` (S26 onboarding).
     * Both now call the one function; this is what stops a third appearing.
     */
    const dir = new URL("../src/", import.meta.url);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
    const writers: string[] = [];
    for (const f of files) {
      const body = fs.readFileSync(new URL(f, dir), "utf8");
      if (/INSERT\s+INTO\s+(config_versions|project_instructions_versions)/i.test(body)) {
        writers.push(f);
      }
    }
    check("only one file writes a version row", 1, writers.length);
    check("and it is config.ts", "config.ts", writers[0] ?? "(none)");
    if (writers.length > 1) console.log(`        also writing: ${writers.join(", ")}`);
  }

  console.log("\n########## the immutable list is data, and all of it refuses ##########\n");
  {
    for (const [domain, label] of Object.entries(IMMUTABLE_DOMAINS)) {
      const got = immutableDomain(`${domain}.something`);
      check(`${domain}.* is ${label}`, label, got);
    }
    for (const [key, label] of Object.entries(IMMUTABLE_KEYS)) {
      check(`${key} on its own is ${label}`, label, immutableDomain(key));
    }
    check("an ordinary key is not protected", null, immutableDomain("queue.default_priority"));
    check("and neither is a schedule", null, immutableDomain("schedule:nightly"));
    // The match is on the whole first segment, not a prefix of it: a key called
    // `authorisation.x` is not `auth.x`.
    check("a key that merely starts with the same letters is not protected",
      null, immutableDomain("authorisation.mode"));
  }

  console.log("\n########## a sentence changes a project he is not talking about ##########\n");
  {
    const said = `from now on Alpha deploys only after I say so (${STAMP})`;
    const r = await applyConfigChange(pool, {
      scope: "project",
      projectId: alpha,
      key: "deploy.policy",
      value: { requires_approval: true, note: said },
      actor: "user",
      note: "spoken instruction",
      conversationId: convo,
      causedByMessage: said,
    });
    truthy("it applies", r.applied);
    check("as version 1", 1, r.applied ? r.version : -1);

    const row = await pool.query<{ project_id: string; conversation_id: string; caused_by_message: string }>(
      `SELECT project_id, conversation_id, caused_by_message FROM config_versions
       WHERE key = 'deploy.policy' AND project_id = $1`, [alpha]);
    check("against Alpha", alpha, row.rows[0]?.project_id);
    // The plan: "versioned with the conversation that caused it".
    check("carrying the conversation it was said in", convo, row.rows[0]?.conversation_id);
    check("and his own words", said, row.rows[0]?.caused_by_message);

    const audited = await pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'config.change' AND project_id = $1`, [alpha]);
    check("and it is audited", 1, audited.rowCount);
  }

  console.log("\n########## refused: the immutable list, with nothing applied ##########\n");
  {
    for (const [key, what] of [
      ["isolation.cross_project_reads", "isolation"],
      ["spend_ceiling_cents", "a spend ceiling"],
      ["audit.retention_days", "the audit log"],
      ["always_confirm.repo_delete", "the always-confirm list"],
      ["backup.enabled", "backups"],
    ] as const) {
      const before = await pool.query(
        `SELECT count(*)::int AS n FROM config_versions WHERE key = $1`, [key]);
      const r = await applyConfigChange(pool, {
        scope: "project", projectId: alpha, key, value: "whatever he asked for",
        actor: "user", note: "spoken instruction", conversationId: convo,
        causedByMessage: `turn off ${what} (${STAMP})`,
      });
      check(`${key} is refused`, false, r.applied);
      truthy(`...as ${what}`, !r.applied && r.refused === "immutable");
      const after = await pool.query(
        `SELECT count(*)::int AS n FROM config_versions WHERE key = $1`, [key]);
      check("...and nothing was written", before.rows[0].n, after.rows[0].n);
      truthy("...but an approval was raised, so the ask is not lost",
        !r.applied && r.refused === "immutable" && r.issueId);
    }
  }

  console.log("\n########## refused: ambiguous, and not even recorded ##########\n");
  {
    const before = await pool.query(`SELECT count(*)::int AS n FROM config_versions`);
    /*
     * The value here is deliberately VALID ("high" is a legal priority). An
     * earlier draft used a nonsense value, and the assertion below passed under
     * sabotage for the wrong reason — the value validator caught it, so the
     * ambiguity rule was never the thing being tested. The only thing that may
     * stop this write is the ambiguity.
     */
    const r = await applyConfigChange(pool, {
      scope: "project", projectId: alpha, key: "queue.default_priority",
      value: "high", actor: "user", note: "spoken instruction",
      conversationId: convo, causedByMessage: `make alpha faster maybe (${STAMP})`,
      ambiguous: "Do you mean Alpha's queue priority, or how many tasks run at once?",
    });
    check("it is refused", false, r.applied);
    truthy("with exactly one question", !r.applied && r.refused === "ambiguous" && Boolean(r.question));
    const after = await pool.query(`SELECT count(*)::int AS n FROM config_versions`);
    check("and nothing at all was written", before.rows[0].n, after.rows[0].n);

    // An unambiguous but nonsense value is a different refusal: it IS a change,
    // it is just not a legal one.
    const bad2 = await applyConfigChange(pool, {
      scope: "project", projectId: alpha, key: "queue.default_priority",
      value: "sort of urgent", actor: "user", note: "spoken instruction",
    });
    check("a value that is not one of the allowed ones is refused too", false, bad2.applied);
    truthy("...as invalid rather than ambiguous", !bad2.applied && bad2.refused === "invalid");
  }

  console.log("\n########## auditable a week later ##########\n");
  {
    // Age one row deliberately so "last week" has something on each side of it.
    await applyConfigChange(pool, {
      scope: "project", projectId: alpha, key: "deploy.policy",
      value: { requires_approval: false }, actor: "user", note: "second thoughts",
      conversationId: convo, causedByMessage: `actually let alpha deploy freely (${STAMP})`,
    });
    await pool.query(
      `UPDATE config_versions SET at = now() - interval '20 days'
       WHERE key = 'deploy.policy' AND project_id = $1 AND version = 1`, [alpha]);

    const all = await configHistory(pool, { projectId: alpha, key: "deploy.policy" });
    check("both versions are in the history", 2, all.length);
    check("newest first", 2, all[0]?.version);
    truthy("each carrying what was said to cause it",
      all.every((h) => (h.caused_by_message ?? "").includes(STAMP)));

    const lastWeek = await configHistory(pool, {
      projectId: alpha, key: "deploy.policy",
      since: new Date(Date.now() - 7 * 24 * 3600 * 1000),
    });
    check("and 'what changed last week' excludes the older one", 1, lastWeek.length);
    check("...which is the recent one", 2, lastWeek[0]?.version);
  }

  console.log("\n########## rolled back, exactly, without rewriting history ##########\n");
  {
    const v1 = await pool.query<{ value: unknown }>(
      `SELECT value FROM config_versions WHERE key = 'deploy.policy' AND project_id = $1 AND version = 1`,
      [alpha]);
    const r = await rollbackConfig(pool, {
      projectId: alpha, key: "deploy.policy", toVersion: 1, actor: "user",
      conversationId: convo, causedByMessage: `put alpha back how it was (${STAMP})`,
    });
    truthy("the rollback applies", r.applied);
    check("as a NEW version, not an edit of the old one", 3, r.applied ? r.version : -1);

    const now = await pool.query<{ value: unknown }>(
      `SELECT value FROM config_versions WHERE key = 'deploy.policy' AND project_id = $1
       ORDER BY version DESC LIMIT 1`, [alpha]);
    check("and the value is version 1's, exactly",
      JSON.stringify(v1.rows[0].value), JSON.stringify(now.rows[0].value));

    const kept = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM config_versions WHERE key = 'deploy.policy' AND project_id = $1`,
      [alpha]);
    check("all three versions survive — what happened, happened", "3", kept.rows[0].n);
  }

  console.log("\n########## a project's instructions are configuration too ##########\n");
  {
    const body = `# Agent instructions — Alpha ${STAMP}\n\n## Environments\n- Production deploy: only when he says so\n`;
    const first = await applyInstructionsChange(pool, {
      projectId: alpha, body, actor: "jarvis", conversationId: convo,
      causedByMessage: `write alpha's rules down (${STAMP})`,
    });
    check("v1 is written", 1, "version" in first ? first.version : -1);

    const changed = await applyInstructionsChange(pool, {
      projectId: alpha, body: body.replace("only when he says so", `never on a Friday (${STAMP})`),
      actor: "user", conversationId: convo,
      causedByMessage: `stop alpha deploying on fridays (${STAMP})`,
    });
    check("and a spoken change is v2", 2, "version" in changed ? changed.version : -1);

    const prov = await pool.query<{ conversation_id: string; caused_by_message: string }>(
      `SELECT conversation_id, caused_by_message FROM project_instructions_versions
       WHERE project_id = $1 AND version = 2`, [alpha]);
    check("versioned with the conversation that caused it", convo, prov.rows[0]?.conversation_id);

    // The S26 rule holds on every later version, not only the first.
    const holed = await applyInstructionsChange(pool, {
      projectId: alpha, body: `${body}\n- Setup: {{setup_command}}\n`, actor: "user",
    });
    truthy("a version with a placeholder left in it is refused",
      "error" in holed && holed.error.includes("placeholder"));
    check("an empty body is refused", true,
      "error" in (await applyInstructionsChange(pool, { projectId: alpha, body: "  ", actor: "user" })));

    const back = await rollbackInstructions(pool, { projectId: alpha, toVersion: 1, actor: "user" });
    check("rolling back writes v3", 3, "version" in back ? back.version : -1);
    const restored = await pool.query<{ body: string }>(
      `SELECT body FROM project_instructions_versions WHERE project_id = $1 ORDER BY version DESC LIMIT 1`,
      [alpha]);
    check("whose body is v1's, exactly", body, restored.rows[0]?.body.endsWith("\n") ? restored.rows[0].body : `${restored.rows[0]?.body}\n`);
  }

  console.log("\n########## a sentence, through the tool the model actually calls ##########\n");
  {
    /*
     * Everything above tests the write path. This tests the thing a spoken
     * sentence reaches: the tool. It runs through the same dispatcher a model
     * turn drives, and — the point of the whole step — the conversation is
     * scoped to Beta while every change lands on Alpha.
     */
    const { runTool } = await import("../src/supervisor.js");

    // Alpha needs recorded onboarding answers before a field can be changed.
    const answers: Record<string, string> = {
      name: `Alpha ${STAMP}`, project_name: `Alpha ${STAMP}`,
      project_type: "professional", production_status: "staging", customer_facing: "no",
      confidentiality: "normal", github_owner: "none", github_repo: "none",
      default_branch: "main", allowed_auth_profiles: "none", approved_data_processors: "none",
      setup_command: "pnpm install", test_command: "pnpm test", lint_command: "none",
      safe_environments: "staging", deploy_policy: "anyone may deploy",
      project_forbidden: "none", before_pr: "tests green", before_deploy: "none",
      migration_policy: "none", default_queue_priority: "normal",
    };
    const { renderAgentsMd } = await import("../src/agentsfile.js");
    const seed = renderAgentsMd(answers as never);
    if (!seed.ok) throw new Error(`fixture render failed: ${seed.missing.join(", ")}`);
    await pool.query(
      `INSERT INTO project_instructions_versions
         (project_id, version, body, created_by, parsed_policy)
       VALUES ($1, COALESCE((SELECT max(version) FROM project_instructions_versions
                             WHERE project_id = $1), 0) + 1, $2, 'jarvis', $3)`,
      [alpha, seed.body, JSON.stringify(answers)]);

    const said = `from now on nobody deploys Alpha without asking me (${STAMP})`;
    const r = await runTool(pool, convo, "", "config_change", {
      project: `alpha-${STAMP}`, field: "deploy_policy",
      value: `ask Enrique first (${STAMP})`, said,
    }, said);
    truthy("the tool reports the change", r.includes("deploy_policy is now"));

    const now = await pool.query<{ body: string; caused_by_message: string; created_by: string }>(
      `SELECT body, caused_by_message, created_by FROM project_instructions_versions
       WHERE project_id = $1 ORDER BY version DESC LIMIT 1`, [alpha]);
    truthy("Alpha's AGENTS.md now says what he said", now.rows[0]?.body.includes(`ask Enrique first (${STAMP})`));
    check("recorded as his, not Jarvis's idea", "user", now.rows[0]?.created_by);
    check("with his sentence attached", said, now.rows[0]?.caused_by_message);
    truthy("and the rest of the file is intact, not rewritten",
      now.rows[0]?.body.includes("Setup: pnpm install") && now.rows[0]?.body.includes("Test: pnpm test"));

    // Naming a project that does not exist is a question, never a default.
    const nowhere = await runTool(pool, convo, "", "config_change", {
      project: "a-project-that-does-not-exist", field: "deploy_policy", value: "x",
    }, "");
    truthy("an unknown project is refused by name", nowhere.includes("no project called"));
    truthy("...and the real ones are offered", nowhere.includes(`alpha-${STAMP}`));

    // The immutable list, through the tool.
    const refused = await runTool(pool, convo, "", "config_change", {
      project: `alpha-${STAMP}`, key: "isolation.cross_project", value: "off",
      said: `let alpha read beta's files (${STAMP})`,
    }, "");
    truthy("an immutable change is refused through the tool too", refused.includes("refused"));
    truthy("...saying an approval is waiting", refused.includes("approval"));
    truthy("...and that nothing changed", refused.includes("Nothing was changed"));

    // Ambiguity, through the tool.
    const asked = await runTool(pool, convo, "", "config_change", {
      project: `alpha-${STAMP}`, key: "queue.default_priority", value: "high",
      ambiguous: "Alpha's queue priority, or how many run at once?",
    }, "");
    truthy("an ambiguous instruction comes back as one question", asked.startsWith("ask him:"));

    // History, through the tool: his words are what makes it answerable.
    const hist = JSON.parse(await runTool(pool, convo, "", "config_history",
      { project: `alpha-${STAMP}`, days: "30" }, ""));
    truthy("history covers the AGENTS.md change", hist.agents_md.length >= 1);
    truthy("carrying what he said", JSON.stringify(hist).includes(said));

    /*
     * And rolled back through the tool. Guarded rather than indexed blindly:
     * when the sabotage round pointed the tool at the wrong project, this line
     * threw on an empty history and killed the suite BEFORE the Beta
     * assertions — which are the ones that catch that exact bug. A test that
     * dies on the way to its own point is worse than one that fails.
     */
    const oldest = hist.agents_md[hist.agents_md.length - 1];
    if (!oldest) {
      bad("rollback reports a new version", "a version to roll back to", "no history at all");
    } else {
      const back = await runTool(pool, convo, "", "config_rollback",
        { project: `alpha-${STAMP}`, to_version: String(oldest.version) }, "");
      truthy("rollback reports a new version", back.includes("recorded as version"));
    }
  }

  console.log("\n########## and none of it touched Beta ##########\n");
  {
    const bconf = await pool.query(`SELECT count(*)::int AS n FROM config_versions WHERE project_id = $1`, [beta]);
    check("Beta has no configuration versions", 0, bconf.rows[0].n);
    const binst = await pool.query(
      `SELECT count(*)::int AS n FROM project_instructions_versions WHERE project_id = $1`, [beta]);
    check("and no instructions", 0, binst.rows[0].n);
    ok("...which is the point: the conversation was scoped to Beta the whole time");
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

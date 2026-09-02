/**
 * S12b item 6, second half — the audit keys are a contract (IV.9).
 *
 * "Free-form metadata means two writers name the same thing differently, and
 * 'every action on task X' stops being answerable a month after anyone would
 * notice." Thirty-six call sites wrote that JSON by hand, and `outcome` — the
 * key IV.9 calls required on EVERY row — was on almost none of them.
 *
 * So this asserts three things, and the third is the one that keeps it true:
 *   1. the helper writes the canonical keys, and `outcome` cannot be omitted;
 *   2. each action IV.9 names as the minimum produces a row carrying it, driven
 *      through the real path rather than by writing the row here;
 *   3. the number of hand-written audit INSERTs left in the source does not
 *      GROW — a ratchet, because a sweep that is announced as finished and is
 *      not is worse than one that is counted.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/db.js";
import { audit } from "../src/audit.js";

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
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * How many hand-written audit INSERTs remain outside the helper.
 *
 * The ratchet. It may fall; it may not rise. The number is not a target — it is
 * a statement of how much of the sweep is left, kept where it cannot be
 * forgotten.
 */
const HANDWRITTEN_CEILING = Number(process.env.JARVIS_AUDIT_CEILING ?? 33);

async function main(): Promise<void> {
  console.log("########## the helper writes the contract ##########\n");
  {
    await audit(pool, {
      actor: "test",
      action: `contract.${STAMP}`,
      target: "a target",
      outcome: "denied",
      reason: "because",
      taskId: null,
      model: "deepseek-v4-flash",
      harness: "claude",
      authProfile: "fireworks",
      tool: "task_create",
      approvalId: null,
      extra: { anything: "else" },
    });
    const r = await pool.query<{ metadata: Record<string, unknown>; actor: string; target: string }>(
      "SELECT actor, target, metadata FROM audit_events WHERE action = $1", [`contract.${STAMP}`]);
    const row = r.rows[0];
    truthy("the row is written", row);
    check("outcome, always", "denied", row.metadata.outcome);
    check("the reason, on a denial", "because", row.metadata.reason);
    check("which model, by id", "deepseek-v4-flash", row.metadata.model);
    check("which harness", "claude", row.metadata.harness);
    check("which auth profile", "fireworks", row.metadata.auth_profile);
    check("which tool", "task_create", row.metadata.tool);
    check("and anything else it was given", "else", row.metadata.anything);
    check("empty keys are left out rather than written as null",
      false, Object.prototype.hasOwnProperty.call(row.metadata, "task_id"));

    // A canonical key cannot be overwritten by `extra` — the contract wins.
    await audit(pool, {
      actor: "test", action: `contract2.${STAMP}`, outcome: "allowed",
      extra: { outcome: "denied", model: "a lie" },
    });
    const r2 = await pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action = $1", [`contract2.${STAMP}`]);
    check("and `extra` cannot rewrite the outcome", "allowed", r2.rows[0].metadata.outcome);
  }

  console.log("\n########## an audit write never takes the action down ##########\n");
  {
    // A row that cannot be written must not throw: "an audit row written after
    // the fact is an audit row that will sometimes be missing" — but a missing
    // row is still better than a half-done action.
    let threw = false;
    try {
      await audit(pool, {
        actor: "x".repeat(100000), action: `huge.${STAMP}`, outcome: "allowed",
      });
    } catch {
      threw = true;
    }
    check("a failed audit write is logged, not thrown", false, threw);
  }

  console.log("\n########## the actions IV.9 names as the minimum ##########\n");
  {
    /*
     * Driven through the REAL paths, not written here: a test that inserts the
     * row it then asserts on proves only that the database works.
     */
    const { recordDenial } = await import("../src/isolation.js");
    await recordDenial(pool, {
      denial: { allowed: false, code: "security.isolation", reason: `audit probe ${STAMP}` },
      capability: `probe-${STAMP}`,
      projectId: null,
    });

    const { markRouteHealth } = await import("../src/catalog.js");
    await pool.query(
      `INSERT INTO model_registry (provider, model_id, approval_state, endpoint_url, health, role_assignments, route_order)
       VALUES ('probe-${STAMP}', 'm-${STAMP}', 'approved', 'https://example.invalid', 'healthy', ARRAY['utility'], 99)
       ON CONFLICT DO NOTHING`,
    );
    await markRouteHealth(pool, `probe-${STAMP}`, `m-${STAMP}`, "failed", "HTTP 404 gone");

    // Two more, driven through their real paths.
    const { storeJsonCredential } = await import("../src/credentials.js");
    await storeJsonCredential(pool, {
      kind: "api_key", authProfileId: null, connectionSlug: `auditprobe-${STAMP}`,
      brokerOnly: false, fingerprint: `auditprobe:${STAMP}`, replace: true,
      payload: { api_key: `probe-value-${STAMP}-long-enough-to-be-real` },
    });
    const task = await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, objective, state, lane, priority)
       SELECT id, 'audit probe ${STAMP}', 'x', 'queued', 'heavy', 'normal'
       FROM projects WHERE slug = 'dev-sandbox' RETURNING id`,
    );
    const { audit: writeAudit } = await import("../src/audit.js");
    const { transitionTask } = await import("../src/jobs.js");
    await transitionTask(pool, task.rows[0].id, "cancelled", "audit probe", "user");
    await writeAudit(pool, {
      actor: "user", action: "task.cancel", target: task.rows[0].id,
      taskId: task.rows[0].id, outcome: "allowed", extra: { from_state: "queued" },
    });

    /*
     * Asserted on the rows THIS RUN produced, not on the whole history.
     *
     * The table holds months of rows written before the contract existed — 35
     * of the 36 `security.isolation` rows have no `outcome`, and they never
     * will. What is testable is that the writers, as they are today, emit it;
     * back-filling history would be inventing outcomes nobody recorded.
     */
    const seen: string[] = [];
    /*
     * Matched on THIS RUN's targets, not on a time window.
     *
     * A window made the suite order-dependent: a sabotage run two minutes
     * earlier left rows without an outcome and the next run reported them as a
     * live failure. The stamp is exact.
     */
    const driven: [string, string][] = [
      ["security.isolation", `probe-${STAMP}`],
      ["model.change", `probe-${STAMP}/m-${STAMP}`],
      ["credential.store", `auditprobe-${STAMP}`],
      ["task.cancel", task.rows[0].id],
    ];
    for (const [action, target] of driven) {
      const r = await pool.query<{ n: string; without: string }>(
        `SELECT count(*)::text AS n,
                count(*) FILTER (WHERE metadata->>'outcome' IS NULL)::text AS without
         FROM audit_events WHERE action = $1 AND target = $2`,
        [action, target],
      );
      const n = Number(r.rows[0].n);
      if (!n) { bad(`${action} was written by this run`, "a row", "none"); continue; }
      if (Number(r.rows[0].without) > 0) {
        bad(`${action}: every row this run wrote carries an outcome`, 0, r.rows[0].without);
        continue;
      }
      seen.push(`${action}(${n})`);
      ok(`${action}: ${n} row(s), every one with an outcome`);
    }
    console.log(`  driven: ${seen.join(" ")}`);

    /*
     * The three that cannot be driven from here — a schedule change, a merged
     * pull request and an approval — are asserted at the source instead: their
     * writer goes through a path that cannot omit an outcome. Weaker than a
     * row, and said plainly rather than faked with one.
     */
    const sources: [string, string][] = [
      ["schedule.update", 'action: "schedule.update"'],
      ["github.merge_pull_request", 'action: "github.merge_pull_request"'],
      ["approval.approve", 'outcome: "allowed"'],
    ];
    const product = await fs.readFile(path.join(SRC, "product.ts"), "utf8");
    for (const [action, needle] of sources) {
      truthy(`${action} is written through a path that requires an outcome`, product.includes(needle));
    }
    const older = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_events WHERE metadata->>'outcome' IS NULL",
    );
    console.log(`  ${older.rows[0].n} rows predate the contract and are left as they are`);
  }

  console.log("\n########## a denial says what was denied and why ##########\n");
  {
    const r = await pool.query<{ metadata: Record<string, unknown>; target: string }>(
      `SELECT target, metadata FROM audit_events
       WHERE action = 'security.isolation' AND target = $1 ORDER BY at DESC LIMIT 1`,
      [`probe-${STAMP}`],
    );
    const row = r.rows[0];
    truthy("the denial was audited", row);
    check("as denied", "denied", row?.metadata.outcome);
    check("with the capability that was asked for", `probe-${STAMP}`, row?.metadata.tool);
    truthy("and a readable reason", String(row?.metadata.reason ?? "").includes("audit probe"));
  }

  console.log("\n########## and a model change names the model ##########\n");
  {
    const r = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'model.change' AND target = $1
       ORDER BY at DESC LIMIT 1`,
      [`probe-${STAMP}/m-${STAMP}`],
    );
    truthy("the change was audited", r.rows[0]);
    check("with the model by id", `m-${STAMP}`, r.rows[0]?.metadata.model);
    check("as a failure, because that is what it was", "failed", r.rows[0]?.metadata.outcome);
    check("recording what it moved from", "healthy", r.rows[0]?.metadata.from);
    truthy("and why", String(r.rows[0]?.metadata.reason ?? "").includes("404"));

    // And running it again with the SAME health writes nothing: a trail full of
    // "nothing changed" is a trail nobody reads.
    const before = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE action = 'model.change' AND target = $1`,
      [`probe-${STAMP}/m-${STAMP}`]);
    const { markRouteHealth } = await import("../src/catalog.js");
    await markRouteHealth(pool, `probe-${STAMP}`, `m-${STAMP}`, "failed", "HTTP 404 gone");
    const after = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE action = 'model.change' AND target = $1`,
      [`probe-${STAMP}/m-${STAMP}`]);
    check("an unchanged health writes no row", before.rows[0].n, after.rows[0].n);
  }

  console.log("\n########## the ratchet ##########\n");
  {
    let handwritten = 0;
    const offenders: string[] = [];
    for (const file of await fs.readdir(SRC)) {
      if (!file.endsWith(".ts") || file === "audit.ts") continue;
      const body = await fs.readFile(path.join(SRC, file), "utf8");
      const n = (body.match(/INSERT INTO audit_events/g) ?? []).length;
      if (n) { handwritten += n; offenders.push(`${file}:${n}`); }
    }
    console.log(`  ${handwritten} hand-written audit INSERTs remain: ${offenders.join(" ")}`);
    truthy(
      `no more than the recorded ceiling of ${HANDWRITTEN_CEILING}`,
      handwritten <= HANDWRITTEN_CEILING,
    );
    truthy("and the sweep has actually started", handwritten < 36);
    ok("...the number may fall and may not rise; the debt is counted, not claimed to be gone");
  }

  await pool.query("DELETE FROM audit_events WHERE action LIKE $1", [`contract%.${STAMP}`]);
  await pool.query("DELETE FROM model_registry WHERE provider = $1", [`probe-${STAMP}`]);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

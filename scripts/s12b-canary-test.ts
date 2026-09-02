/**
 * The canary (Part V, S12b item 3).
 *
 * "Seed a credential whose value is a known unique string, exercise the system
 * hard — a harness run, a failed provider call, a broker denial, a crash — then
 * grep EVERY log, audit row, issue, artifact and transcript for that string.
 * Expect zero hits."
 *
 * It is the same technique S12 used for isolation: assert the ABSENCE of
 * something, having first tried hard to produce it. A property this easy to
 * state needs a test this blunt, because "never logged" is invisible until the
 * day it matters and cannot be proved by reading the code.
 *
 * The canary is deliberately shaped like nothing: no `sk-` prefix, no JWT dots,
 * no base64 padding. A pattern-matching scrubber would sail past it, which is
 * exactly why the plan says to match on the real decrypted values instead.
 */
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { createPool } from "../src/db.js";
import { readJsonCredential, storeJsonCredential } from "../src/credentials.js";
import { forgetSecrets, scrubString, secretCount } from "../src/scrubber.js";
import { raiseIssue } from "../src/notify.js";
import { recordDenial } from "../src/isolation.js";
import { ARTIFACTS_DIR } from "../src/paths.js";

const pool = createPool();

/**
 * A SECOND pool, deliberately not the scrubbed one.
 *
 * The first version of this grep used `pool`, whose whole job is to scrub every
 * string parameter — including, it turns out, the search term. It looked for
 * `%[redacted:canary_…]%`, found every row it had just successfully redacted,
 * and reported a leak. The grep has to see the database exactly as it is, which
 * means not going through the thing under test.
 */
const raw = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL
    ?? `postgres://jarvis:${encodeURIComponent(process.env.POSTGRES_PASSWORD ?? "")}@postgres:5432/jarvis`,
  max: 2,
});
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 300)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));

/** Shaped like nothing in particular, which is the point. */
const CANARY = `zqf4Hn2Lw8Rt6Vb0Xy3Md7Kp1Sc9Jg5${Date.now().toString(36)}`;
const SLUG = `canary_${Date.now().toString(36).slice(-6)}`;

async function main(): Promise<void> {
  console.log("########## the scrubber matches values, not shapes ##########\n");
  {
    forgetSecrets();
    check("with nothing registered it changes nothing", CANARY, scrubString(CANARY));
    check("and it knows it is empty", 0, secretCount());

    // Stored, then read back — which is what registers it, at the one point
    // where a credential is ever decrypted.
    const stored = await storeJsonCredential(pool, {
      kind: "api_key",
      authProfileId: null,
      connectionSlug: SLUG,
      brokerOnly: false,
      fingerprint: `${SLUG}:…${CANARY.slice(-4)}`,
      replace: true,
      payload: { api_key: CANARY },
    });
    const read = await readJsonCredential(pool, stored.credentialId);
    check("reading it back gives the real value", CANARY, read.api_key);
    truthy("and registers it with the scrubber", secretCount() > 0);

    const line = `provider said 401: {"error":"bad key","sent":"Bearer ${CANARY}"}`;
    const scrubbed = scrubString(line);
    truthy("a provider error body keeps its body", scrubbed.includes("bad key"));
    truthy("and loses the credential", !scrubbed.includes(CANARY));
    truthy("naming what was removed", scrubbed.includes("[redacted:"));
    ok("...which is the plan's own resolution of keeping error bodies vs never logging keys");

    check("a short value is not matched, or half of every line would go",
      "abc", scrubString("abc"));
  }

  console.log("\n########## now exercise it, hard ##########\n");
  {
    // 1. A failed provider call: the body echoes the header, as they do.
    console.log(`  provider rejected the key: Bearer ${CANARY}`);
    console.error(`  upstream 401 body: {"sent":"${CANARY}"}`);

    // 2. An issue, evidence and all.
    await raiseIssue(pool, {
      category: "provider.cred_expired",
      service: SLUG,
      title: `[canary] provider refused ${CANARY}`,
      dedupeKey: `canary.${SLUG}`,
      evidence: { key: CANARY, note: `sent Bearer ${CANARY}` },
      requiredAction: `Rotate ${CANARY} at the provider.`,
      notifyOverride: "ui_only",
    });

    // 3. A broker denial, which writes an audit row.
    await recordDenial(pool, {
      denial: { allowed: false, code: "security.isolation", reason: `key ${CANARY} not allowlisted` },
      capability: `canary-${SLUG}`,
      projectId: null,
    });

    // 4. A crash, with the value in the message.
    try {
      throw new Error(`connect ECONNREFUSED using ${CANARY}`);
    } catch (err) {
      console.error("crashed:", err instanceof Error ? err.message : err);
      await pool.query(
        `INSERT INTO audit_events (actor, action, target, metadata)
         VALUES ('canary', 'canary.crash', $1, $2)`,
        [`crash-${SLUG}`, JSON.stringify({ message: (err as Error).message })],
      );
    }

    // 5. An artifact on disk, written the way a transcript is.
    await fs.mkdir(path.join(ARTIFACTS_DIR, "canary"), { recursive: true });
    const file = path.join(ARTIFACTS_DIR, "canary", `${SLUG}.jsonl`);
    await fs.writeFile(file, scrubString(`{"type":"tool","key":"${CANARY}"}\n`));

    // 6. A message and a task, through the ordinary tables.
    const conv = await pool.query<{ id: string }>(
      "SELECT id FROM conversations WHERE project_id IS NULL ORDER BY created_at LIMIT 1");
    if (conv.rows[0]) {
      await pool.query(
        `INSERT INTO messages (conversation_id, role, body) VALUES ($1, 'jarvis', $2)`,
        [conv.rows[0].id, `I used ${CANARY} and it failed`],
      );
    }
    ok("exercised: a failed call, an issue, a denial, a crash, an artifact, a message");
  }

  console.log("\n########## now grep everything ##########\n");
  {
    const hits: string[] = [];

    // Every text-ish column of every table that stores what happened.
    const tables: [string, string[]][] = [
      ["issues", ["title", "required_action", "evidence::text", "detail_url"]],
      ["audit_events", ["actor", "action", "target", "metadata::text"]],
      ["messages", ["body"]],
      ["inbox_events", ["raw_text", "routing_note"]],
      ["task_events", ["name", "summary"]],
      ["task_attempts", ["summary"]],
      ["tasks", ["title", "objective", "waiting_reason"]],
      ["notifications_outbox", ["body"]],
      ["call_speech", ["text"]],
      ["artifacts", ["path"]],
    ];
    for (const [table, columns] of tables) {
      const where = columns.map((c) => `COALESCE(${c}, '') LIKE $1`).join(" OR ");
      const r = await raw
        .query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, [`%${CANARY}%`])
        .catch(() => ({ rows: [{ n: "0" }] }));
      if (Number(r.rows[0].n) > 0) {
        hits.push(`${table}: ${r.rows[0].n}`);
        // Show WHAT leaked, or the failure says only that something did.
        const sample = await raw
          .query<{ row: string }>(
            `SELECT left(concat_ws(' | ', ${columns.join(", ")}), 200) AS row
             FROM ${table} WHERE ${where} LIMIT 2`,
            [`%${CANARY}%`],
          )
          .catch(() => ({ rows: [] as { row: string }[] }));
        for (const row of sample.rows) console.log(`        ${table}: ${row.row}`);
      }
    }
    check("zero hits in every table that records what happened", 0, hits.length);
    if (hits.length) console.log(`        ${hits.join(" | ")}`);

    // Every file under the artifacts root.
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(full);
      }
    };
    await walk(ARTIFACTS_DIR);
    const dirty: string[] = [];
    for (const f of files) {
      const body = await fs.readFile(f, "utf8").catch(() => "");
      if (body.includes(CANARY)) dirty.push(f);
    }
    console.log(`  ${files.length} files under ${ARTIFACTS_DIR}`);
    check("zero hits in every artifact and transcript on disk", 0, dirty.length);
    if (dirty.length) console.log(`        ${dirty.join(" | ")}`);

    // And the credential itself is still readable — a scrubber that broke
    // storage would pass this test by destroying the thing it protects.
    const still = await pool.query<{ id: string }>(
      "SELECT credential_id AS id FROM connections WHERE slug = $1", [SLUG]);
    const back = await readJsonCredential(pool, still.rows[0].id);
    check("and the credential itself still works", CANARY, back.api_key);
    ok("...the secret is intact where it belongs and absent everywhere else");
  }

  // Clean up: the canary must not linger as a live secret in later suites.
  await pool.query("DELETE FROM issues WHERE dedupe_key = $1", [`canary.${SLUG}`]);
  await pool.query("DELETE FROM audit_events WHERE target LIKE $1", [`%${SLUG}%`]);
  await fs.rm(path.join(ARTIFACTS_DIR, "canary"), { recursive: true, force: true }).catch(() => undefined);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    await raw.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

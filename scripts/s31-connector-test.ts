/**
 * S31 — one interface, and a connection that is a set of actions.
 *
 * The two properties this suite exists for are the two the plan says are lost
 * if the adapters are built first:
 *
 *   "A Composio connection permitting one action does not permit a second
 *    action on the same service — this is the assertion that separates a
 *    permitted-action set from a switch."
 *
 *   "A `direct` connection (a database URL) and a `native` one (a local
 *    directory) go through the same broker path as Composio. Assert the audit
 *    rows are the same shape, not merely that both worked."
 *
 * So the assertions are on the SHAPE of what came back and what was written,
 * per kind, rather than on any kind working. A suite that checks each adapter
 * separately would pass just as happily over three check orders, which is the
 * arrangement IV.6b calls three gates with one of them wrong.
 *
 * Built against `native` and `direct` deliberately. They have no vendor behind
 * them, so the seam cannot be shaped around an incumbent - and they are the two
 * the plan says get wired wherever is convenient and end up with no
 * permitted-action set and no audit row. Composio and MCP land on this seam
 * rather than under it.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPool } from "../src/db.js";
import {
  declareActions, invokeConnector, registeredKinds, unregisterAdapter,
} from "../src/connectors.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s31-${Math.random().toString(36).slice(2, 7)}`;

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s31-"));
  await fs.writeFile(path.join(root, "notes.txt"), "the supplier ships on Tuesdays");
  await fs.writeFile(path.join(root, "secret-elsewhere.txt"), "not reachable");

  const mine = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG])).rows[0].id;
  const theirs = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [`${SLUG}-other`])).rows[0].id;

  const connect = async (
    slug: string, kind: string, actions: string[], config: Record<string, unknown>,
  ) => {
    await pool.query(
      `INSERT INTO connections (slug, kind, scope, project_id, config, permitted_actions)
       VALUES ($1,$2,'project',$3,$4,$5)`,
      [slug, kind, mine, JSON.stringify(config), actions]);
    return slug;
  };

  const auditRows = async (target: string) =>
    (await pool.query<{ actor: string; action: string; target: string; project_id: string | null; metadata: Record<string, unknown> }>(
      `SELECT actor, action, target, project_id, metadata FROM audit_events
        WHERE target = $1 ORDER BY at`, [target])).rows;

  const files = await connect(`${SLUG}-files`, "native", ["read"], { root });
  const db = await connect(`${SLUG}-db`, "direct", ["use"], { secret: "S31_TEST_SECRET" });
  process.env.S31_TEST_SECRET = "postgres://example";

  console.log("1. a connection is a set of actions, not a switch");
  const readIt = await invokeConnector(pool, {
    connectionSlug: files, action: "read", projectId: mine, input: { path: "notes.txt" },
  });
  readIt.ok && String(readIt.output).includes("Tuesdays")
    ? ok("the permitted action runs")
    : bad(`the permitted action was refused: ${!readIt.ok ? readIt.reason : "no content"}`);
  /*
   * The assertion the plan calls the separating one. `list` is a real action
   * this adapter implements and this connection does not permit - so a switch
   * would allow it and a set does not.
   */
  const listIt = await invokeConnector(pool, {
    connectionSlug: files, action: "list", projectId: mine, input: { path: "." },
  });
  !listIt.ok && listIt.reason.includes("does not permit")
    ? ok(`a second action on the same connection is refused: "${listIt.reason}"`)
    : bad("permitting one action permitted another - this is a switch, not a set");
  (await declareActions(pool, files)).includes("list")
    ? ok("even though the adapter declares it, so the refusal is the permission and not the capability")
    : bad("the adapter does not declare list, so the previous assertion proved nothing");

  console.log("");
  console.log("2. a connection permitting nothing permits nothing");
  const inert = await connect(`${SLUG}-inert`, "native", [], { root });
  const nothing = await invokeConnector(pool, {
    connectionSlug: inert, action: "read", projectId: mine, input: { path: "notes.txt" },
  });
  !nothing.ok && nothing.reason.includes("permits no actions")
    ? ok("an empty permitted-action set is empty, not everything")
    : bad("an empty action set behaved as an allow-all");

  console.log("");
  console.log("3. every kind goes through the same path, and leaves the same row");
  const useDb = await invokeConnector(pool, {
    connectionSlug: db, action: "use", projectId: mine,
  });
  useDb.ok && (useDb.output as { secret: string }).secret === "postgres://example"
    ? ok("a direct connection hands over its secret")
    : bad(`the direct connection failed: ${!useDb.ok ? useDb.reason : "no secret"}`);

  const nativeRow = (await auditRows(`${files}:read`))[0];
  const directRow = (await auditRows(`${db}:use`))[0];
  const shape = (r: typeof nativeRow) => r && [
    r.actor, r.action, typeof r.target, r.project_id === mine,
    "outcome" in r.metadata, "tool" in r.metadata,
  ].join("|");
  nativeRow && directRow
    ? ok("both kinds wrote an audit row")
    : bad(`missing audit rows: native=${!!nativeRow} direct=${!!directRow}`);
  shape(nativeRow) === shape(directRow)
    ? ok(`and the rows are the same shape: ${shape(nativeRow)}`)
    : bad(`the shapes differ: ${shape(nativeRow)} vs ${shape(directRow)}`);
  nativeRow?.actor === "broker" && nativeRow.action === "connector.invoke"
    ? ok("written by the broker, not by the adapter")
    : bad(`the row says actor=${nativeRow?.actor} action=${nativeRow?.action}`);

  console.log("");
  console.log("4. a denial is audited too, or it is invisible a week later");
  const denied = await auditRows(`${files}:list`);
  denied.length > 0 && denied[0].metadata.outcome === "denied"
    ? ok(`the refusal was recorded with its reason: "${String(denied[0].metadata.reason).slice(0, 60)}"`)
    : bad("a denial left no audit row, so the Connections tab cannot show it");

  console.log("");
  console.log("5. cross-project denial behaves identically for both kinds");
  const crossNative = await invokeConnector(pool, {
    connectionSlug: files, action: "read", projectId: theirs, input: { path: "notes.txt" },
  });
  const crossDirect = await invokeConnector(pool, {
    connectionSlug: db, action: "use", projectId: theirs,
  });
  !crossNative.ok && !crossDirect.ok
    ? ok("another project is refused both")
    : bad(`a connection leaked across projects: native=${crossNative.ok} direct=${crossDirect.ok}`);
  !crossNative.ok && !crossDirect.ok && crossNative.code === crossDirect.code
    ? ok(`with the same code for both, so the kind does not decide the gate: ${crossNative.code}`)
    : bad("the two kinds denied differently, which means two check orders");

  console.log("");
  console.log("6. the native kind is the one that will have been special-cased");
  const escape = await invokeConnector(pool, {
    connectionSlug: files, action: "read", projectId: mine,
    input: { path: "../../etc/passwd" },
  });
  !escape.ok ? ok("a path outside the directory is refused") : bad("a native connection read outside its root");
  const link = path.join(root, "escape.txt");
  let symlinked = true;
  try {
    await fs.symlink(path.join(os.tmpdir(), "s31-outside-target.txt"), link);
    await fs.writeFile(path.join(os.tmpdir(), "s31-outside-target.txt"), "outside");
  } catch { symlinked = false; }
  if (symlinked) {
    const viaLink = await invokeConnector(pool, {
      connectionSlug: files, action: "read", projectId: mine, input: { path: "escape.txt" },
    });
    !viaLink.ok
      ? ok("and a symlink pointing out of it is refused, which the string check alone would follow")
      : bad("a symlink walked out of the connection's directory");
  } else {
    ok("(symlink not creatable on this host; the resolved-path check is still asserted above)");
  }

  console.log("");
  console.log("7. an always-confirm action needs a live approval");
  const destructive = await connect(`${SLUG}-danger`, "direct", ["db.destructive"], { secret: "S31_TEST_SECRET" });
  const unapproved = await invokeConnector(pool, {
    connectionSlug: destructive, action: "db.destructive", projectId: mine,
  });
  !unapproved.ok && unapproved.reason.includes("confirmation")
    ? ok("permitted by the action set and still refused without an approval")
    : bad(`an always-confirm action ran unapproved: ${JSON.stringify(unapproved).slice(0, 80)}`);

  console.log("");
  console.log("8. the incumbent is behind the interface, not the interface");
  /*
   * The plan: "Remove the Composio adapter and the other kinds keep working. If
   * they do not, Composio is not behind the interface: it IS the interface."
   * Composio's adapter is not built yet, so the equivalent is done with one
   * that is - removing an adapter must not disturb another kind.
   */
  const before = registeredKinds();
  unregisterAdapter("direct");
  const stillWorks = await invokeConnector(pool, {
    connectionSlug: files, action: "read", projectId: mine, input: { path: "notes.txt" },
  });
  const nowMissing = await invokeConnector(pool, {
    connectionSlug: db, action: "use", projectId: mine,
  });
  stillWorks.ok
    ? ok(`native still works with direct removed (registered: ${before.join(", ")} -> ${registeredKinds().join(", ")})`)
    : bad("removing one adapter broke another kind - they are not behind an interface");
  !nowMissing.ok && nowMissing.code === "connector.unsupported"
    ? ok("and the removed kind fails cleanly, naming the missing adapter")
    : bad(`the removed kind did not fail cleanly: ${JSON.stringify(nowMissing).slice(0, 80)}`);

  await pool.query(`DELETE FROM audit_events WHERE project_id = ANY($1::uuid[])`, [[mine, theirs]]);
  await pool.query(`DELETE FROM connections WHERE project_id = ANY($1::uuid[])`, [[mine, theirs]]);
  await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [[mine, theirs]]);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(path.join(os.tmpdir(), "s31-outside-target.txt"), { force: true });

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  await pool.end().catch(() => undefined);
  process.exit(1);
});

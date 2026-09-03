/**
 * S31 — the third kind on the seam, and the first carrying a real secret.
 *
 * The plan is specific that the interface has to be built against more than its
 * two vendors: "an interface that only Composio and MCP fit is a coincidence,
 * not an abstraction. Build it against a plain API key and a native local-files
 * connection at the same time, or the seam gets shaped around the incumbent and
 * the incumbent is the thing it exists to survive."
 *
 * So this is the plain API key, making a REAL HTTP call - to the dev stack's own
 * API, because a suite that asserts an adapter works by mocking fetch asserts
 * that the mock works. And the assertions that matter are not "the call
 * succeeded": they are that the credential came from the broker rather than
 * from the caller, that this kind produces the same audit row as the other two,
 * and that it is inert until classified like every other tool-bearing kind.
 */
import { createPool } from "../src/db.js";
import { invokeConnector, registerAdapter } from "../src/connectors.js";
import { storeJsonCredential } from "../src/credentials.js";
import { classifyTool, syncTools } from "../src/tools.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s31api-${Math.random().toString(36).slice(2, 7)}`;
/** The dev stack's own API, reachable from the runner container by name. */
const BASE = process.env.S31_API_BASE ?? "http://api:8080";

async function main(): Promise<void> {
  const pid = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG])).rows[0].id;
  const other = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [`${SLUG}-other`])).rows[0].id;

  const cred = await storeJsonCredential(pool, {
    kind: "api_key",
    payload: { api_key: "s31-not-a-real-key-0000" },
    fingerprint: `${SLUG}:api_key`,
    brokerOnly: false,
    authProfileId: null,
  });

  const connId = (await pool.query<{ id: string }>(
    `INSERT INTO connections (slug, kind, scope, project_id, config, permitted_actions)
     VALUES ($1,'api','project',$2,$3,$4) RETURNING id`,
    [SLUG, pid, JSON.stringify({
      base_url: BASE,
      credential_id: cred.credentialId,
      operations: { health: { method: "GET", path: "/api/health" } },
    }), ["health"]])).rows[0].id;

  const call = (projectId: string, action = "health", extra: Record<string, unknown> = {}) =>
    invokeConnector(pool, { connectionSlug: SLUG, action, projectId, ...extra });

  console.log("1. an api connection is tool-bearing, so it is inert until classified");
  await syncTools(pool, connId, [{ name: "health", description: "Reports whether the service is up." }]);
  const early = await call(pid);
  !early.ok && early.reason.includes("not been classified")
    ? ok("the same inert-until-classified rule applies to a plain API key")
    : bad(`an api operation ran unclassified: ${JSON.stringify(early).slice(0, 90)}`);

  console.log("");
  console.log("2. classified, it makes a real call");
  await classifyTool(pool, { connectionId: connId, name: "health", level: 1, by: "enrique" , capability: "read whether the supplier service is up" });
  const res = await call(pid);
  res.ok ? ok("the call succeeded") : bad(`the call failed: ${!res.ok ? res.reason : ""}`);
  const out = res.ok ? res.output as { untrusted?: boolean; data?: unknown } : null;
  out?.untrusted === true
    ? ok("and its response is labelled untrusted, like any other tool-bearing kind")
    : bad(`the response is not labelled: ${JSON.stringify(out).slice(0, 80)}`);
  JSON.stringify(out?.data ?? "").length > 2
    ? ok(`with a real body from a real endpoint: ${JSON.stringify(out?.data).slice(0, 60)}`)
    : bad("the body is empty, so nothing was actually fetched");

  console.log("");
  console.log("3. the secret comes from the broker, and a caller cannot supply one");
  /*
   * Asserted on what the adapter ACTUALLY RECEIVED, not on whether the call
   * succeeded. My first version attached an attacker-supplied key and checked
   * the request still worked - which /api/health would answer identically with
   * any key or none, so it would have passed over a broker that merged the
   * caller's value straight through. The property is about the value handed to
   * the adapter, so that is what is inspected.
   */
  const seen: (Record<string, string> | undefined)[] = [];
  registerAdapter({
    kind: "composio",
    async declare() { return ["probe"]; },
    async invoke(_conn, i) { seen.push(i.secret); return "probed"; },
  });
  const withCred = (await pool.query<{ id: string }>(
    `INSERT INTO connections (slug, kind, scope, project_id, config, permitted_actions)
     VALUES ($1,'composio','project',$2,$3,$4) RETURNING id`,
    [`${SLUG}-probe`, pid,
      JSON.stringify({ credential_id: cred.credentialId }), ["probe"]])).rows[0].id;
  await syncTools(pool, withCred, [{ name: "probe", description: "Records what it was handed." }]);
  await classifyTool(pool, { connectionId: withCred, name: "probe", level: 1, by: "enrique" , capability: "record what the broker handed it" });

  await invokeConnector(pool, {
    connectionSlug: `${SLUG}-probe`, action: "probe", projectId: pid,
    secret: { api_key: "attacker-supplied" },
  });
  seen[0]?.api_key === "s31-not-a-real-key-0000"
    ? ok("the adapter was handed the broker's credential, not the caller's")
    : bad(`the adapter received ${JSON.stringify(seen[0])}`);

  const noCred = (await pool.query<{ id: string }>(
    `INSERT INTO connections (slug, kind, scope, project_id, config, permitted_actions)
     VALUES ($1,'composio','project',$2,'{}'::jsonb,$3) RETURNING id`,
    [`${SLUG}-nocred`, pid, ["probe"]])).rows[0].id;
  await syncTools(pool, noCred, [{ name: "probe", description: "Records what it was handed." }]);
  await classifyTool(pool, { connectionId: noCred, name: "probe", level: 1, by: "enrique" , capability: "record what the broker handed it" });
  await invokeConnector(pool, {
    connectionSlug: `${SLUG}-nocred`, action: "probe", projectId: pid,
    secret: { api_key: "attacker-supplied" },
  });
  seen[1] === undefined
    ? ok("and a connection with no credential hands over nothing, rather than the caller's value")
    : bad(`a caller's secret reached the adapter: ${JSON.stringify(seen[1])}`);

  const leaked = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_events
      WHERE project_id = $1 AND (metadata::text LIKE '%not-a-real-key%'
                              OR metadata::text LIKE '%attacker-supplied%')`, [pid]);
  Number(leaked.rows[0].n) === 0
    ? ok("and no secret, ours or theirs, reached an audit row")
    : bad(`${leaked.rows[0].n} audit rows contain a secret`);

  console.log("");
  console.log("4. the same broker path, and the same audit row");
  const row = (await pool.query<{ actor: string; action: string; metadata: Record<string, unknown> }>(
    `SELECT actor, action, metadata FROM audit_events
      WHERE target = $1 AND metadata->>'outcome' = 'allowed' ORDER BY at LIMIT 1`,
    [`${SLUG}:health`])).rows[0];
  row?.actor === "broker" && row.action === "connector.invoke"
    ? ok("written by the broker, with the same action name as native and direct")
    : bad(`the row is ${JSON.stringify(row).slice(0, 80)}`);
  row && "tool" in row.metadata && "outcome" in row.metadata
    ? ok("and the same metadata shape")
    : bad("the metadata shape differs from the other kinds");

  console.log("");
  console.log("5. cross-project denial is the same for this kind too");
  const cross = await call(other);
  !cross.ok && cross.code === "security.isolation"
    ? ok("another project is refused, with the isolation code the other kinds give")
    : bad(`cross-project access was not denied identically: ${JSON.stringify(cross).slice(0, 80)}`);

  console.log("");
  console.log("6. an undeclared operation is refused before anything is called");
  await pool.query(`UPDATE connections SET permitted_actions = $2 WHERE id = $1`,
    [connId, ["health", "drop_everything"]]);
  await syncTools(pool, connId, [{ name: "drop_everything", description: "Totally harmless." }]);
  await classifyTool(pool, { connectionId: connId, name: "drop_everything", level: 1, by: "enrique" , capability: "call an operation this connection does not declare" });
  const undeclared = await call(pid, "drop_everything");
  !undeclared.ok && undeclared.reason.includes("no operation")
    ? ok("permitted and classified, and still refused because the connection declares no such operation")
    : bad(`an undeclared operation was attempted: ${JSON.stringify(undeclared).slice(0, 90)}`);

  console.log("");
  console.log("7. a non-2xx is a failure, not an answer");
  await pool.query(
    `UPDATE connections SET config = jsonb_set(config, '{operations,missing}', $2::jsonb) WHERE id = $1`,
    [connId, JSON.stringify({ method: "GET", path: "/api/definitely-not-here" })]);
  await pool.query(`UPDATE connections SET permitted_actions = $2 WHERE id = $1`,
    [connId, ["health", "drop_everything", "missing"]]);
  await syncTools(pool, connId, [{ name: "missing", description: "Fetches a page that is not there." }]);
  await classifyTool(pool, { connectionId: connId, name: "missing", level: 1, by: "enrique" , capability: "fetch a page that is not there" });
  const notFound = await call(pid, "missing");
  !notFound.ok && notFound.reason.includes("HTTP 404")
    ? ok(`an error page is reported as a failure: "${notFound.reason}"`)
    : bad(`a non-2xx came back as an answer: ${JSON.stringify(notFound).slice(0, 90)}`);

  await pool.query(`DELETE FROM audit_events WHERE project_id = ANY($1::uuid[])`, [[pid, other]]);
  await pool.query(`DELETE FROM connection_tools WHERE connection_id = ANY($1::uuid[])`, [[connId, withCred, noCred]]);
  await pool.query(`DELETE FROM connections WHERE id = ANY($1::uuid[])`, [[connId, withCred, noCred]]);
  await pool.query(`DELETE FROM credentials WHERE id = $1`, [cred.credentialId]);
  await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [[pid, other]]);

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

/**
 * S31 — what the Connections tab reads, and what revoking actually takes away.
 *
 *   "The Connections tab shows a CAPABILITY, not a tool name, and a denial from
 *    this week is visible on it. Then revoke from that page and confirm the
 *    browser session is cleared and the generated credential is revoked at the
 *    provider — assert on the far side, not on the row."
 *
 * "Assert on the far side, not on the row" is the instruction this suite is
 * built around, and it rules out the obvious test. Checking that `disabled_at`
 * is set, or that the response said "revoked", asserts on exactly the thing a
 * broken revoke would also produce. So the assertions here are: the credential
 * cannot be read afterwards, and an invocation that worked a moment ago now
 * fails.
 */
import { createPool } from "../src/db.js";
import { invokeConnector } from "../src/connectors.js";
import { connectionViews, revokeConnection } from "../src/connections.js";
import { readJsonCredential, storeJsonCredential } from "../src/credentials.js";
import { classifyTool, syncTools } from "../src/tools.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s31conn-${Math.random().toString(36).slice(2, 7)}`;
const BASE = process.env.S31_API_BASE ?? "http://api:8080";

async function main(): Promise<void> {
  const pid = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG])).rows[0].id;
  const cred = await storeJsonCredential(pool, {
    kind: "api_key", payload: { api_key: "s31-conn-key-0000" },
    fingerprint: `${SLUG}:api_key`, brokerOnly: false, authProfileId: null,
  });
  const connId = (await pool.query<{ id: string }>(
    `INSERT INTO connections (slug, kind, scope, project_id, config, permitted_actions, credential_id)
     VALUES ($1,'api','project',$2,$3,$4,$5) RETURNING id`,
    [SLUG, pid, JSON.stringify({
      base_url: BASE, credential_id: cred.credentialId,
      operations: { health: { method: "GET", path: "/api/health" } },
    }), ["health", "wipe"], cred.credentialId])).rows[0].id;

  await syncTools(pool, connId, [
    { name: "health", description: "Reports whether the service is up." },
    { name: "wipe", description: "Utterly harmless housekeeping." },
  ]);

  const view = async () => (await connectionViews(pool)).find((v) => v.slug === SLUG);

  console.log("1. before classification, the tab has nothing to show but a question");
  const before = await view();
  before?.capabilities.length === 0
    ? ok("no capabilities are listed for tools nobody has classified")
    : bad(`capabilities appeared unbidden: ${JSON.stringify(before?.capabilities)}`);
  before?.waitingOnYou === 2
    ? ok("and both tools are counted as waiting on a person")
    : bad(`waitingOnYou is ${before?.waitingOnYou}`);

  console.log("");
  console.log("2. it shows a capability, not a tool name");
  await classifyTool(pool, {
    connectionId: connId, name: "health", level: 1, by: "enrique",
    capability: "check whether the supplier's service is up",
  });
  await classifyTool(pool, {
    connectionId: connId, name: "wipe", level: 3, by: "enrique",
    capability: "erase every order in the supplier's system",
  });
  const shown = await view();
  const caps = shown?.capabilities.map((c) => c.capability) ?? [];
  caps.includes("erase every order in the supplier's system")
    ? ok(`the tab says what it can do: "${caps.join('", "')}"`)
    : bad(`the capabilities are ${JSON.stringify(caps)}`);
  /*
   * The assertion that gives the previous one its teeth. "wipe" and "health"
   * are the tool NAMES, and the plan's complaint is that a name tells a reader
   * nothing - so a page built from names would pass the assertion above by
   * accident if the capability text happened to contain them.
   */
  !caps.some((c) => c === "wipe" || c === "health")
    ? ok("and never falls back to the raw tool name")
    : bad("a tool name is being shown as a capability");
  shown?.capabilities.find((c) => c.capability.startsWith("erase"))?.level === 3
    ? ok("with the blast radius beside it")
    : bad("the level is not shown next to the capability");

  console.log("");
  console.log("3. a denial from this week is visible on it");
  const denied = await invokeConnector(pool, {
    connectionSlug: SLUG, action: "wipe", projectId: pid,
  });
  !denied.ok ? ok("a Level 3 call without approval is refused") : bad("the Level 3 call ran");
  const withDenial = await view();
  withDenial?.recentDenials.some((d) => d.action === "wipe" && d.reason.includes("Level 3"))
    ? ok(`and it is on the tab, with its reason: "${withDenial.recentDenials[0].reason}"`)
    : bad(`the denial is not visible: ${JSON.stringify(withDenial?.recentDenials)}`);

  console.log("");
  console.log("4. the capability works, so revoking it means something");
  const worked = await invokeConnector(pool, {
    connectionSlug: SLUG, action: "health", projectId: pid,
  });
  worked.ok
    ? ok("the connection makes a real call before revocation")
    : bad(`it did not work beforehand, so the revoke proves nothing: ${!worked.ok ? worked.reason : ""}`);

  console.log("");
  console.log("5. revoke, and assert on the far side");
  const result = await revokeConnection(pool, SLUG, "enrique");
  result.ok && result.localCredentialDestroyed
    ? ok("revoke reports that it destroyed the credential it held")
    : bad(`revoke reported ${JSON.stringify(result)}`);
  /*
   * The far side, first half: the credential cannot be read. Not "a column
   * says revoked" - the bytes are gone, so anything still holding the id gets
   * nothing.
   */
  let readable = true;
  try {
    await readJsonCredential(pool, cred.credentialId);
  } catch {
    readable = false;
  }
  !readable
    ? ok("the credential can no longer be read, by anything holding its id")
    : bad("the credential is still decryptable after revocation");

  // Second half: the capability itself is gone.
  const after = await invokeConnector(pool, {
    connectionSlug: SLUG, action: "health", projectId: pid,
  });
  !after.ok
    ? ok(`and the call that worked a moment ago now fails: "${after.reason}"`)
    : bad("the connection still works after being revoked");

  console.log("");
  console.log("6. and it says plainly what it did NOT do");
  /*
   * The plan asks for the key to be revoked AT THE PROVIDER. Jarvis cannot do
   * that for a plain API key, and a status message claiming otherwise is how a
   * live key sits in somebody's dashboard for a year. The honest half has to be
   * stated rather than implied by silence.
   */
  result.providerRevocation.includes("not attempted")
    ? ok(`the provider half is reported honestly: "${result.providerRevocation.slice(0, 60)}..."`)
    : bad("the response implies the provider revoked the key");

  console.log("");
  console.log("7. a revoked connection cannot inherit its old classification");
  const reattached = await view();
  reattached?.capabilities.length === 0
    ? ok("the tools lost their classification, so re-attaching has to ask again")
    : bad(`classifications survived revocation: ${JSON.stringify(reattached?.capabilities)}`);
  reattached?.hasCredential === false
    ? ok("and the connection no longer claims to hold a credential")
    : bad("the connection still points at a credential");

  await pool.query(`DELETE FROM audit_events WHERE project_id = $1 OR target = $2`, [pid, SLUG]);
  await pool.query(`DELETE FROM connection_tools WHERE connection_id = $1`, [connId]);
  await pool.query(`DELETE FROM connections WHERE id = $1`, [connId]);
  await pool.query(`DELETE FROM credentials WHERE id = $1`, [cred.credentialId]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [pid]);

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

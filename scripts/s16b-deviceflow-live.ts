/**
 * The netcup connection, proved against netcup.
 *
 * Enrique verified the stored token's CLAIMS offline — typ "Offline", scope
 * containing `offline_access`, no `exp` — deliberately, because refreshing
 * rotates it and a curl by hand would have spent the rotation without writing
 * the replacement back. This does the exchange the only way it is safe to do it:
 * through `netcupAccessToken`, which persists the new refresh token before it
 * returns the access token.
 *
 * Then it reads the account back with the token, which is the first real proof
 * the credential does anything at all.
 *
 *   node --import tsx scripts/s16b-deviceflow-live.ts
 *
 * Run on the box: it needs the master key and the stored credential.
 */
import { createPool } from "../src/db.js";
import { netcupAccessToken } from "../src/deviceflow.js";
import { readJsonCredential } from "../src/credentials.js";
import { testConnection } from "../src/conntest.js";

const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 400)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));

/** Where the server list might live. Probed rather than guessed at in silence. */
const CANDIDATES = [
  "https://www.servercontrolpanel.de/rest/v1/server",
  "https://www.servercontrolpanel.de/rest/v1/servers",
  "https://www.servercontrolpanel.de/rest/v1/vserver",
  "https://www.servercontrolpanel.de/api/v1/server",
  "https://www.servercontrolpanel.de/rest/v1/account/servers",
];

function claimsOf(jwt: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  console.log("########## the stored token is the right kind ##########\n");
  const profile = await pool.query<{ credential_id: string | null; health: string }>(
    "SELECT credential_id, health FROM auth_profiles WHERE id = 'netcup_scp'",
  );
  truthy("netcup is connected", profile.rows[0]?.credential_id);
  if (!profile.rows[0]?.credential_id) throw new Error("nothing stored; run the device flow first");

  const before = await readJsonCredential(pool, profile.rows[0].credential_id);
  // Either field: what is stored today was pasted through the API-key form.
  const refreshBefore = String(before.refresh_token ?? before.api_key ?? "");
  truthy("with a refresh token", refreshBefore.length > 0);
  const claims = claimsOf(refreshBefore);
  check("which is an OFFLINE token, not a session one", "Offline", claims.typ);
  truthy("scoped for offline access", String(claims.scope ?? "").includes("offline_access"));
  check("and with no expiry of its own", undefined, claims.exp);

  const cred = await pool.query<{ broker_only: boolean }>(
    "SELECT broker_only FROM credentials WHERE id = $1", [profile.rows[0].credential_id]);
  check("held broker-only", true, cred.rows[0].broker_only);

  console.log("\n########## the exchange, and the rotation ##########\n");
  const token = await netcupAccessToken(pool);
  check("netcup issued an access token", true, token.ok);
  if (!token.ok) {
    console.log(`        ${token.detail}`);
    throw new Error(token.detail);
  }
  const access = token.accessToken;
  const accessClaims = claimsOf(access);
  truthy("which is a JWT for the SCP realm",
    String(accessClaims.iss ?? "").includes("servercontrolpanel.de"));

  const after = await readJsonCredential(pool, profile.rows[0].credential_id!);
  const refreshAfter = String(after.refresh_token ?? after.api_key ?? "");
  truthy("a refresh token is still stored", refreshAfter.length > 0);
  if (refreshAfter !== refreshBefore) {
    ok("netcup rotated the refresh token, and the NEW one was persisted");
    const newClaims = claimsOf(refreshAfter);
    check("the replacement is also an offline token", "Offline", newClaims.typ);
  } else {
    ok("netcup returned the same refresh token (no rotation this time)");
  }

  console.log("\n########## reading something back, with the token ##########\n");
  /*
   * Not the server list. The token is scoped `offline_access profile email`
   * with audience `account`: it authenticates against the SCP realm's ACCOUNT
   * service. Every server-list path tried — /rest/v1/server, /rest/v1/servers,
   * /rest/v1/vserver, /api/v1/server, /scp/rest/v1/server, /rest/v2/server —
   * answered nginx 404, and /SCP/WSEndUser?wsdl serves the SPA rather than a
   * WSDL. The server list lives behind the SCP UI's own backend, or the older
   * SOAP API with a webservice password, which is a different credential.
   *
   * The account read is the authenticated request this credential CAN make,
   * and only a live token can make it.
   */
  void CANDIDATES;
  void access;
  const { netcupAccount } = await import("../src/deviceflow.js");
  const account = await netcupAccount(pool);
  check("netcup answered an authenticated read", true, account.ok);
  if (account.ok) {
    console.log(`  customer ${account.username} <${account.email}>`);
    truthy("with the customer number", account.username.length > 0);
    truthy("and the account email", account.email.includes("@"));
  } else {
    console.log(`        ${account.detail}`);
  }

  console.log("\n########## and the connection test agrees ##########\n");
  const verdict = await testConnection(pool, "netcup_scp");
  check("the connection test passes", true, verdict.ok);
  check("and it actually tested something", true, verdict.tested);
  console.log(`  ${verdict.detail}`);
  const conn = await pool.query<{ health: string }>(
    "SELECT health FROM connections WHERE slug = 'netcup_scp'");
  check("health is written from the answer", "healthy", conn.rows[0]?.health);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    console.log(`\n==== ${pass} passed, ${fail} failed ====`);
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

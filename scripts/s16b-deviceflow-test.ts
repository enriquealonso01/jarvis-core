/**
 * The OAuth device flow (netcup SCP).
 *
 * `[setup] netcup_scp OAuth not connected` was a blocker nobody could clear. The
 * action request declared `oauth_connect`; the code behind it stored a pasted
 * string; and netcup issues refresh tokens exclusively through Keycloak's device
 * code grant, so there was no string to paste. The banner was permanent by
 * construction.
 *
 * The provider's real shape is asserted separately, against the live endpoint,
 * by `scripts/s16b-deviceflow-live.ts`. What is asserted here is everything that
 * happens around it — the pending/slow_down/approved sequence, where the secrets
 * end up, and what happens when the human says no.
 */
import { createPool } from "../src/db.js";
import { DEVICE_PROVIDERS, exerciseRefreshToken, pollDeviceFlow, startDeviceFlow } from "../src/deviceflow.js";
import { readJsonCredential } from "../src/credentials.js";

const pool = createPool();
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

async function reset(): Promise<void> {
  /*
   * The queued sign-in links go too. Starting a flow now hands the link over to
   * WhatsApp (S46), so this suite's five fake flows leave ten outbox rows that
   * the worker would try to DELIVER - a real message to his phone about a
   * connection nobody asked for. Scoped to the flows this profile owns, and run
   * before they are deleted, so the join still resolves.
   */
  await pool.query(
    `DELETE FROM notifications_outbox
      WHERE idempotency_key LIKE 'device-flow:%'
        AND object_id IN (SELECT id FROM oauth_device_flows
                           WHERE auth_profile_id = 'netcup_scp')`);
  await pool.query("DELETE FROM oauth_device_flows WHERE auth_profile_id = 'netcup_scp'");
  await pool.query("UPDATE auth_profiles SET credential_id = NULL WHERE id = 'netcup_scp'");
}

async function main(): Promise<void> {
  console.log("########## the provider is the one that was verified ##########\n");
  {
    const p = DEVICE_PROVIDERS.netcup_scp;
    truthy("netcup is registered as a device-flow provider", p);
    check("the device endpoint is the SCP realm's",
      "https://www.servercontrolpanel.de/realms/scp/protocol/openid-connect/auth/device", p.deviceUrl);
    check("the token endpoint is its sibling",
      "https://www.servercontrolpanel.de/realms/scp/protocol/openid-connect/token", p.tokenUrl);
    check("with the client id netcup expects", "scp", p.clientId);

    const nope = await startDeviceFlow(pool, "groq", "enrique");
    check("a profile that has a key to paste is refused a device flow", false, nope.ok);
  }

  console.log("\n########## a code the human can type in ##########\n");
  await reset();
  let flowId = "";
  {
    const started = await startDeviceFlow(pool, "netcup_scp", "enrique");
    truthy("a flow starts", started.ok);
    if (!started.ok) throw new Error(started.error);
    flowId = started.flowId;
    truthy("with a user code to read out", started.userCode.length > 0);
    truthy("and a URL to open", started.verificationUri.startsWith("http"));
    truthy("and a complete URL that saves typing the code", started.verificationUriComplete);

    const row = await pool.query<{ device_code: string; state: string; user_code: string }>(
      "SELECT device_code, state, user_code FROM oauth_device_flows WHERE id = $1", [flowId]);
    truthy("the DEVICE code is kept server-side", row.rows[0].device_code.length > 0);
    check("and is not what the browser was given", true, row.rows[0].device_code !== started.userCode);
    check("the flow is pending", "pending", row.rows[0].state);

    // Starting again supersedes the first: two live codes is a confusing screen.
    const second = await startDeviceFlow(pool, "netcup_scp", "enrique");
    truthy("a second attempt starts", second.ok);
    const first = await pool.query<{ state: string }>(
      "SELECT state FROM oauth_device_flows WHERE id = $1", [flowId]);
    check("and the first code is retired rather than left live", "expired", first.rows[0].state);
    if (second.ok) flowId = second.flowId;
  }

  console.log("\n########## pending, then slow down, then approved ##########\n");
  {
    process.env.JARVIS_DEVICEFLOW_APPROVE_AT = "3";
    const first = await pollDeviceFlow(pool, flowId);
    check("the first poll is pending, which is not an error", "pending", first.state);

    const second = await pollDeviceFlow(pool, flowId);
    check("a slow_down is also pending", "pending", second.state);
    if (second.state === "pending" && first.state === "pending") {
      truthy("and it backs off rather than hammering", second.interval > first.interval);
    }

    const third = await pollDeviceFlow(pool, flowId);
    check("the third poll is the approval", "connected", third.state);

    const prof = await pool.query<{ credential_id: string | null; health: string }>(
      "SELECT credential_id, health FROM auth_profiles WHERE id = 'netcup_scp'");
    truthy("the profile now has a credential", prof.rows[0].credential_id);
    check("and is healthy", "healthy", prof.rows[0].health);

    const cred = await pool.query<{ broker_only: boolean; kind: string }>(
      "SELECT broker_only, kind FROM credentials WHERE id = $1", [prof.rows[0].credential_id]);
    check("stored broker-only, so no worker can ever be handed it", true, cred.rows[0].broker_only);
    check("as an oauth credential", "oauth", cred.rows[0].kind);

    const payload = await readJsonCredential(pool, prof.rows[0].credential_id!);
    truthy("and what is stored is the refresh token", String(payload.refresh_token ?? "").length > 0);
    truthy("with when it was obtained, for the thirty-day clock", payload.obtained_at);

    const flow = await pool.query<{ state: string; device_code: string }>(
      "SELECT state, device_code FROM oauth_device_flows WHERE id = $1", [flowId]);
    check("the flow is closed", "connected", flow.rows[0].state);
    check("and the device code is wiped once it is spent", "", flow.rows[0].device_code);

    const issue = await pool.query<{ status: string }>(
      "SELECT status FROM issues WHERE dedupe_key = 'setup.oauth.netcup_scp' ORDER BY created_at DESC LIMIT 1");
    if (issue.rowCount) {
      check("and the blocker that could never be cleared is cleared", "resolved", issue.rows[0].status);
    } else {
      ok("(no netcup blocker open in this environment)");
    }
  }

  console.log("\n########## the thirty-day clock ##########\n");
  {
    const exercised = await exerciseRefreshToken(pool, "netcup_scp");
    check("a connected profile can be exercised", true, exercised.ok);
    await pool.query("UPDATE auth_profiles SET credential_id = NULL WHERE id = 'netcup_scp'");
    const missing = await exerciseRefreshToken(pool, "netcup_scp");
    check("an unconnected one says so rather than pretending", false, missing.ok);
    check("in words", "not connected", missing.detail);
  }

  console.log("\n########## when the human says no ##########\n");
  {
    await reset();
    process.env.JARVIS_DEVICEFLOW_RESULT = "denied";
    const started = await startDeviceFlow(pool, "netcup_scp", "enrique");
    if (!started.ok) throw new Error(started.error);
    const verdict = await pollDeviceFlow(pool, started.flowId);
    check("a refusal ends the flow", "denied", verdict.state);
    const again = await pollDeviceFlow(pool, started.flowId);
    truthy("and polling it again does not start a new one", again.state !== "pending");
    const prof = await pool.query<{ credential_id: string | null }>(
      "SELECT credential_id FROM auth_profiles WHERE id = 'netcup_scp'");
    check("nothing was stored", null, prof.rows[0].credential_id);
    process.env.JARVIS_DEVICEFLOW_RESULT = "";
  }

  console.log("\n########## and when the code times out ##########\n");
  {
    await reset();
    const started = await startDeviceFlow(pool, "netcup_scp", "enrique");
    if (!started.ok) throw new Error(started.error);
    await pool.query(
      "UPDATE oauth_device_flows SET expires_at = now() - interval '1 second' WHERE id = $1",
      [started.flowId],
    );
    const verdict = await pollDeviceFlow(pool, started.flowId);
    check("an expired code is reported as expired, not as pending forever", "expired", verdict.state);
    const prof = await pool.query<{ credential_id: string | null }>(
      "SELECT credential_id FROM auth_profiles WHERE id = 'netcup_scp'");
    check("and nothing was stored", null, prof.rows[0].credential_id);
  }

  console.log("\n########## untested is not healthy ##########\n");
  {
    /*
     * The false green Enrique found on netcup was never specific to netcup: any
     * connection without a branch in `testConnection` answered `ok = true` and
     * was written down as healthy. "We stored something" is not "it works".
     */
    const { testConnection } = await import("../src/conntest.js");
    const { storeJsonCredential } = await import("../src/credentials.js");
    await pool.query("DELETE FROM connections WHERE slug = 'zz_no_live_check'");
    await storeJsonCredential(pool, {
      kind: "api_key",
      authProfileId: null,
      connectionSlug: "zz_no_live_check",
      brokerOnly: false,
      fingerprint: "zz:…test",
      replace: true,
      payload: { api_key: "whatever" },
    });
    const verdict = await testConnection(pool, "zz_no_live_check");
    check("a connection with no live check says it was not tested", false, verdict.tested);
    const health = await pool.query<{ health: string }>(
      "SELECT health FROM connections WHERE slug = 'zz_no_live_check'");
    check("and its health is written as unknown, not healthy", "unknown", health.rows[0]?.health);
    await pool.query("DELETE FROM connections WHERE slug = 'zz_no_live_check'");
  }

  await reset();
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

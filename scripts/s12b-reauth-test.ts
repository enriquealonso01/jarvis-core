/**
 * S12b item 6 — Level 3 re-authentication, and an approval bound to what it
 * approved (Part V).
 *
 * The plan's test, verbatim: "an approval with a valid session but no recent
 * password re-entry is refused. Then, with re-auth, it succeeds — and a second
 * Level 3 inside the grace window does not re-prompt."
 *
 * And the binding: *"approve"* clicked against a stale screen "is the failure
 * mode that produces the wrong outcome with a complete audit trail saying it was
 * authorised". So the refusal is asserted, and so is the audit row that explains
 * it — a denial nobody can reconstruct is barely better than no denial.
 */
import { createPool } from "../src/db.js";
import { bindingSha, GRACE_MS, LEVEL3_HOURLY_CEILING } from "../src/reauth.js";

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

const API = process.env.S12B_API ?? "http://api:8080";
const ORIGIN = process.env.JARVIS_ORIGIN ?? "http://localhost:8080";
const EMAIL = process.env.JARVIS_OPERATOR_EMAIL ?? "dev@jarvis.local";
const PASSWORD = process.env.JARVIS_OPERATOR_PASSWORD ?? "dev-password-1234";

let cookie = "";

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { body = { raw: text }; }
  return { status: res.status, body };
}

async function login(): Promise<void> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("no session cookie; cannot test approvals");
}

/** Ask for an approval of a given action type, and get its id. */
async function requestApproval(actionType: string, target: string): Promise<string> {
  const r = await call("/api/approvals", {
    method: "POST",
    body: JSON.stringify({ action_type: actionType, target }),
  });
  const approval = r.body.approval as { id?: string } | undefined;
  if (!approval?.id) throw new Error(`could not create an approval: ${JSON.stringify(r.body).slice(0, 200)}`);
  return approval.id;
}

async function auditFor(approvalId: string): Promise<{ outcome: string; reason: string }[]> {
  const r = await pool.query<{ outcome: string; reason: string }>(
    `SELECT COALESCE(metadata->>'outcome', '') AS outcome, COALESCE(metadata->>'reason', '') AS reason
     FROM audit_events WHERE metadata->>'approval_id' = $1 ORDER BY at`,
    [approvalId],
  );
  return r.rows;
}

async function main(): Promise<void> {
  await login();
  await pool.query("DELETE FROM reauth_events");

  console.log("########## a Level 3 approval is refused without a fresh password ##########\n");
  let level3 = "";
  {
    level3 = await requestApproval("secrets.export", `canary-${Date.now().toString(36)}`);
    const row = await pool.query<{ requires_reauth: boolean; binding_sha: string | null }>(
      "SELECT requires_reauth, binding_sha FROM approvals WHERE id = $1", [level3]);
    check("it is marked as needing re-authentication", true, row.rows[0].requires_reauth);
    truthy("and it is bound to what it approves", row.rows[0].binding_sha);

    const refused = await call(`/api/approvals/${level3}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    check("a valid session alone is not enough", 403, refused.status);
    check("and it says why, in a word the console can act on", "reauth_required", refused.body.error);

    const state = await pool.query<{ state: string }>(
      "SELECT state FROM approvals WHERE id = $1", [level3]);
    check("nothing was approved", "pending", state.rows[0].state);

    const audit = await auditFor(level3);
    truthy("the refusal is on the audit trail", audit.some((a) => a.outcome === "denied"));
    truthy(
      "with a reason a person can read",
      audit.some((a) => a.reason.includes("re-authentication")),
    );
  }

  console.log("\n########## rejecting never asks for a password ##########\n");
  {
    const other = await requestApproval("secrets.export", `reject-${Date.now().toString(36)}`);
    const rejected = await call(`/api/approvals/${other}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision: "reject" }),
    });
    check("a rejection goes through unchallenged", 200, rejected.status);
    ok("...refusing something dangerous must never be the harder path");
  }

  console.log("\n########## the wrong password is not a re-authentication ##########\n");
  {
    const nope = await call("/api/auth/reauth", {
      method: "POST",
      body: JSON.stringify({ password: "not the password" }),
    });
    check("it is refused", 401, nope.status);
    const still = await call(`/api/approvals/${level3}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    check("and the approval is still refused", 403, still.status);

    const audit = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
       WHERE action = 'auth.reauth' AND metadata->>'outcome' = 'denied'
         AND at > now() - interval '2 minutes'`,
    );
    truthy("and the wrong password is audited", Number(audit.rows[0].n) > 0);
  }

  console.log("\n########## with the password, it goes through ##########\n");
  {
    const yes = await call("/api/auth/reauth", {
      method: "POST",
      body: JSON.stringify({ password: PASSWORD }),
    });
    check("the password is accepted", 200, yes.status);
    check("and the grace window is stated", GRACE_MS, yes.body.grace_ms);

    const approved = await call(`/api/approvals/${level3}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    check("the approval now succeeds", 200, approved.status);
    const state = await pool.query<{ state: string }>(
      "SELECT state FROM approvals WHERE id = $1", [level3]);
    check("and the state changed", "approved", state.rows[0].state);

    const audit = await auditFor(level3);
    truthy("the approval is audited as allowed", audit.some((a) => a.outcome === "allowed"));
    const level = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
       WHERE metadata->>'approval_id' = $1 AND metadata->>'level' = '3'`, [level3]);
    truthy("and recorded as Level 3", Number(level.rows[0].n) > 0);
  }

  console.log("\n########## a second one inside the window does not re-prompt ##########\n");
  {
    const second = await requestApproval("db.destructive", `second-${Date.now().toString(36)}`);
    const approved = await call(`/api/approvals/${second}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    check("no second password prompt inside the grace window", 200, approved.status);
    ok(`...which is why the window exists: ${GRACE_MS}ms of related approvals, not theatre`);
  }

  console.log("\n########## and outside it, it asks again ##########\n");
  {
    await pool.query(
      "UPDATE reauth_events SET at = now() - make_interval(secs => $1::int / 1000.0 + 60)",
      [GRACE_MS],
    );
    const third = await requestApproval("repo.delete", `third-${Date.now().toString(36)}`);
    const refused = await call(`/api/approvals/${third}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    check("a stale re-authentication is no re-authentication", 403, refused.status);
  }

  console.log("\n########## an approval clicked against a stale screen ##########\n");
  {
    await call("/api/auth/reauth", { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
    const id = await requestApproval("spend.increase", `stale-${Date.now().toString(36)}`);

    // The screen the operator saw, hashed. Then the request changes underneath.
    const asShown = bindingSha({ actionType: "spend.increase", target: "something else" });
    const refused = await call(`/api/approvals/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", binding_sha: asShown }),
    });
    check("the click is refused", 409, refused.status);
    check("as stale", "stale", refused.body.error);
    const state = await pool.query<{ state: string }>(
      "SELECT state FROM approvals WHERE id = $1", [id]);
    check("and nothing was applied", "pending", state.rows[0].state);
    const audit = await auditFor(id);
    truthy("with the reason on the trail", audit.some((a) => a.reason.includes("stale")));

    // The same click, with the hash the server actually holds, goes through.
    const row = await pool.query<{ binding_sha: string }>(
      "SELECT binding_sha FROM approvals WHERE id = $1", [id]);
    const good = await call(`/api/approvals/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", binding_sha: row.rows[0].binding_sha }),
    });
    check("the same approval, from the screen it was shown on, works", 200, good.status);
  }

  console.log("\n########## and the ceiling ##########\n");
  {
    truthy("there is an hourly ceiling on Level 3", LEVEL3_HOURLY_CEILING > 0);
    truthy("high enough not to be noticed in normal use", LEVEL3_HOURLY_CEILING >= 10);
    ok(`...${LEVEL3_HOURLY_CEILING} an hour, counted from the audit trail rather than a counter`);
  }

  /*
   * Clean up. This suite seeds ALWAYS-CONFIRM approvals, and leaving them
   * pending broke S15's journeys: its approve-something journey finds a row by
   * text and clicks the first Approve button under it, which became one of
   * these — and then correctly demanded a password no browser test was ever
   * going to type. A suite that leaves live Level 3 approvals lying around is a
   * suite that breaks the next one.
   */
  await pool.query(
    "DELETE FROM approvals WHERE state = 'pending' AND action_type IN "
    + "('secrets.export','db.destructive','repo.delete','spend.increase')",
  );
  await pool.query("DELETE FROM reauth_events");

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

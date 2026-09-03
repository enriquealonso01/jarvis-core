/**
 * S12 — isolation, proved.
 *
 * S12 builds nothing. It exists to find out whether what S5, S7 and S10 claimed
 * is actually enforced, and the plan is unusually blunt about the standard:
 * "Any probe that succeeds stops all other work until it is closed."
 *
 * So every probe here is a real attempt at a real boundary, made the way a task
 * would make it — through the broker HTTP endpoint, or through the same
 * functions the Supervisor calls — and the assertion is on what came back plus
 * what was written down. A denial nobody recorded is indistinguishable from one
 * that never happened, which is why each probe asserts the 403, the audit row
 * and (for a cross-project read) the Issue.
 *
 * L11 asks for something stronger than a denial: "deny before HTTP to
 * provider". A test that only checks the return value cannot tell a refusal
 * from a refusal made after the request was already sent. So `fetch` is
 * replaced with a spy for the duration, and the assertion is that the count is
 * zero.
 *
 * The two filesystem probes — Beta's files and Beta's browser profile — are not
 * here. They need a real harness run, so they live in the shell half.
 */
import { createPool } from "../src/db.js";
import { removeFixtures } from "./lib/fixtures.js";
import {
  checkConnectionAccess,
  checkProfileAccess,
  recordDenial,
  type BrokerDecision,
} from "../src/isolation.js";
import { projectOwnedProfileIds, routesForRole } from "../src/catalog.js";
import { encryptGcm, loadMasterKey, newDek, wrapDek } from "../src/crypto.js";

const pool = createPool();
const API = process.env.S12_API ?? "http://api:8080";
const ORIGIN = process.env.JARVIS_ORIGIN ?? "http://localhost:8080";
const STAMP = Date.now().toString(36);

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

/** The secret Beta owns. If this string ever leaves the box, the probe won. */
const BETA_SECRET = `beta-secret-${STAMP}-do-not-leak`;

let cookie = "";
async function login(): Promise<void> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({
      email: process.env.JARVIS_OPERATOR_EMAIL ?? "dev@jarvis.local",
      password: process.env.JARVIS_OPERATOR_PASSWORD ?? "dev-password-1234",
    }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error(`could not log in: ${res.status}`);
}

async function post(p: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${API}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/** Every project made here, so the `finally` can take them away again. */
const created: string[] = [];

async function project(slug: string, type: string, confidentiality: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality,production_status)
     VALUES ($1,$1,$2,$3,'non_production')
     ON CONFLICT (slug) DO UPDATE SET project_type=EXCLUDED.project_type,
       confidentiality=EXCLUDED.confidentiality, archived_at=NULL
     RETURNING id`,
    [slug, type, confidentiality],
  );
  created.push(r.rows[0].id);
  return r.rows[0].id;
}

/** A real encrypted credential, stored the way the broker stores one. */
async function credential(value: string): Promise<string> {
  const dek = newDek();
  const wrapped = wrapDek(loadMasterKey(), dek);
  const { nonce, ciphertext } = encryptGcm(dek, Buffer.from(JSON.stringify({ api_key: value })));
  const k = await pool.query<{ id: string }>(
    "INSERT INTO dek_keys (wrapped_key) VALUES ($1) RETURNING id",
    [wrapped],
  );
  const c = await pool.query<{ id: string }>(
    `INSERT INTO credentials (dek_id, nonce, ciphertext, kind) VALUES ($1,$2,$3,'api_key')
     RETURNING id`,
    [k.rows[0].id, nonce, ciphertext],
  );
  return c.rows[0].id;
}

async function authProfile(
  id: string,
  eligibility: string[],
  credentialId: string | null,
): Promise<string> {
  await pool.query(
    `INSERT INTO auth_profiles (id, provider, display_name, auth_type, confidentiality_eligibility,
       credential_id, health)
     VALUES ($1,'s12',$1,'api_key',$2,$3,'healthy')
     ON CONFLICT (id) DO UPDATE SET confidentiality_eligibility=EXCLUDED.confidentiality_eligibility,
       credential_id=EXCLUDED.credential_id, health='healthy'`,
    [id, eligibility, credentialId],
  );
  return id;
}

async function connection(
  slug: string,
  scope: string,
  projectId: string | null,
  authProfileId: string | null,
  credentialId: string | null,
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO connections (slug, kind, scope, project_id, auth_profile_id, credential_id)
     VALUES ($1,'api',$2,$3,$4,$5)
     ON CONFLICT (slug) DO UPDATE SET scope=EXCLUDED.scope, project_id=EXCLUDED.project_id,
       auth_profile_id=EXCLUDED.auth_profile_id, credential_id=EXCLUDED.credential_id
     RETURNING id`,
    [slug, scope, projectId, authProfileId, credentialId],
  );
  return r.rows[0].id;
}

/** Was the denial written down, as the right class, against the right thing? */
async function audited(action: string, target: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_events
     WHERE action = $1 AND target = $2 AND at > now() - interval '10 minutes'`,
    [action, target],
  );
  return Number(r.rows[0].n);
}

/**
 * Run something with `fetch` replaced, and report how many HTTP calls it made.
 * This is the only way to tell "denied" from "denied after the request left".
 */
async function withoutNetwork<T>(fn: () => Promise<T>): Promise<{ value: T; calls: string[] }> {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    calls.push(String(input));
    return real(input as never, init as never);
  }) as typeof fetch;
  try {
    const value = await fn();
    return { value, calls };
  } finally {
    globalThis.fetch = real;
  }
}

const denialOf = (d: BrokerDecision) => (d.allowed ? "ALLOWED" : d.code);

async function main(): Promise<void> {
  await login();

  const alpha = await project(`s12-alpha-${STAMP}`, "personal", "normal");
  const beta = await project(`s12-beta-${STAMP}`, "professional", "confidential");

  const betaCred = await credential(BETA_SECRET);
  const betaProfile = await authProfile(`s12_beta_${STAMP}`, ["normal", "confidential"], betaCred);
  const freeProfile = await authProfile(`s12_free_${STAMP}`, ["normal"], await credential("free-key"));

  // Beta's secret lives behind a project-scoped connection, and Beta's name is
  // on a second one — the plan lists "secret" and "connection name" as separate
  // probes, so they get separate targets rather than one assertion counted twice.
  const secretSlug = `s12-beta-secret-${STAMP}`;
  const nameSlug = `s12-beta-deploy-${STAMP}`;
  await connection(secretSlug, "project", beta, betaProfile, betaCred);
  await connection(nameSlug, "project", beta, null, null);

  // The profile is allowlisted to Beta and to nobody else.
  await pool.query(
    `INSERT INTO auth_profile_allowlists (auth_profile_id, project_id, allowed_roles)
     VALUES ($1,$2,ARRAY['task_agent']) ON CONFLICT DO NOTHING`,
    [betaProfile, beta],
  );

  console.log("########## L9 — the cross-project probes ##########");
  console.log("(a task in Alpha, reaching for things that belong to Beta)\n");

  // --- probe 1: Beta's secret ---------------------------------------------
  const p1 = await post("/api/broker/resolve", {
    capability: "api.call",
    connection_slug: secretSlug,
    project_id: alpha,
  });
  check("1. Beta's secret — 403", 403, p1.status);
  truthy("   the refusal names isolation", p1.text.includes("security.isolation"));
  check("   and the secret itself is not in the response", false, p1.text.includes(BETA_SECRET));
  check("   audited as security.isolation", true, (await audited("security.isolation", secretSlug)) > 0);
  {
    const leaked = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
       WHERE metadata::text LIKE '%' || $1 || '%'`,
      [BETA_SECRET],
    );
    check("   and not in the audit trail either", "0", leaked.rows[0].n);
  }
  {
    const issue = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM issues
       WHERE category='security.isolation' AND created_at > now() - interval '10 minutes'`,
    );
    check("   and it raised an Issue, not just a log line", true, Number(issue.rows[0].n) > 0);
  }

  // --- probe 2: Beta's connection, by name ---------------------------------
  const p2 = await post("/api/broker/resolve", {
    capability: "git.push",
    connection_slug: nameSlug,
    project_id: alpha,
  });
  check("2. Beta's connection name — 403", 403, p2.status);
  truthy("   the refusal names isolation", p2.text.includes("security.isolation"));
  check("   audited", true, (await audited("security.isolation", nameSlug)) > 0);

  // Beta asking for its own is allowed — otherwise the denial above proves
  // nothing except that the endpoint refuses everything.
  const own = await post("/api/broker/resolve", {
    capability: "git.push",
    connection_slug: nameSlug,
    project_id: beta,
  });
  check("   ...while Beta's own request for it succeeds", 200, own.status);

  // --- probe 3: Beta's model / auth profile --------------------------------
  const p3 = await checkProfileAccess(pool, { authProfileId: betaProfile, projectId: alpha });
  check("3. Beta's model profile — denied", "security.isolation", denialOf(p3));
  if (!p3.allowed) {
    await recordDenial(pool, {
      denial: p3,
      capability: "model.chat",
      projectId: alpha,
      connectionSlug: betaProfile,
    });
    check("   audited", true, (await audited("security.isolation", betaProfile)) > 0);
  }
  const p3role = await checkProfileAccess(pool, {
    authProfileId: betaProfile,
    projectId: beta,
    role: "supervisor",
  });
  check(
    "   and even inside Beta, only for the role it was allowlisted for",
    "security.isolation",
    denialOf(p3role),
  );

  // --- probe 4: an ineligible profile for a confidential project -----------
  const p4 = await checkProfileAccess(pool, { authProfileId: freeProfile, projectId: beta });
  check("4. a free profile for a confidential project — denied", "security.isolation", denialOf(p4));

  // --- probe 5: the admin profile is broker-only ---------------------------
  const p5 = await checkConnectionAccess(pool, { connectionSlug: "github_admin", projectId: alpha });
  truthy("5. the GitHub admin profile is not reachable from a project", !p5.allowed);

  console.log("\n########## L11 — auth-profile isolation, before any HTTP ##########\n");

  // A project-owned profile is one bound to a project by a project-scoped
  // connection. That is what makes it Beta's, and what must keep it out of a
  // system role.
  const owned = await projectOwnedProfileIds(pool);
  check("Beta's profile is recognised as project-owned", true, owned.includes(betaProfile));

  await pool.query(
    `INSERT INTO model_registry (provider, model_id, approval_state, endpoint_url, auth_profile_id,
       health, role_assignments, route_order)
     VALUES ('s12', $1, 'approved', 'https://s12.invalid/v1/chat/completions', $2, 'healthy',
       ARRAY['supervisor'], 1)`,
    [`s12-model-${STAMP}`, betaProfile],
  );

  // Counted BEFORE, because probe 3 already audited this profile. An assertion
  // that only checks "there is a row" would pass on the earlier denial and say
  // nothing at all about this one.
  const auditsBefore = await audited("security.isolation", betaProfile);
  const { value: routes, calls } = await withoutNetwork(() => routesForRole(pool, "supervisor"));
  check(
    "the Supervisor is not offered Beta's profile",
    0,
    routes.filter((r) => r.auth_profile_id === betaProfile).length,
  );
  check("and nothing left the box to find that out", 0, calls.length);
  check(
    "this refusal is audited too, not just the earlier one",
    auditsBefore + 1,
    await audited("security.isolation", betaProfile),
  );

  // The other direction: Beta's confidential code through a personal/free profile.
  const { value: viaFree, calls: calls2 } = await withoutNetwork(() =>
    checkProfileAccess(pool, { authProfileId: freeProfile, projectId: beta, role: "task_agent" }),
  );
  check("Beta's code cannot go through a free profile", "security.isolation", denialOf(viaFree));
  check("and that refusal made no HTTP call either", 0, calls2.length);

  console.log("\n########## L8 — always-confirm actions are blocked ##########\n");

  for (const action of ["repo.delete", "isolation.weaken", "secrets.export", "spend.increase"]) {
    const r = await post("/api/broker/github", { action });
    check(`${action} without an approval — 403`, 403, r.status);
    truthy("   and it says an approval is needed", r.text.includes("Always-confirm"));
  }

  // A pending approval is not an approval.
  const pending = await post("/api/approvals", { action_type: "repo.delete", target: "alpha/repo" });
  const pendingId = JSON.parse(pending.text).approval.id as string;
  check(
    "a pending approval is created for it",
    "pending",
    (await pool.query<{ s: string }>("SELECT state AS s FROM approvals WHERE id=$1", [pendingId]))
      .rows[0].s,
  );
  const withPending = await post("/api/broker/github", {
    action: "repo.delete",
    approval_id: pendingId,
  });
  check("but a PENDING approval does not authorise it", 403, withPending.status);

  // An approval for a different action does not transfer.
  const other = await post("/api/approvals", { action_type: "repo.archive_active" });
  const otherId = JSON.parse(other.text).approval.id as string;
  await pool.query("UPDATE approvals SET state='approved', decided_at=now() WHERE id=$1", [otherId]);
  const crossed = await post("/api/broker/github", { action: "repo.delete", approval_id: otherId });
  check("an approval for another action does not transfer", 403, crossed.status);

  // An expired approval does not authorise it either.
  await pool.query(
    `UPDATE approvals SET state='approved', decided_at=now(), expires_at=now()-interval '1 minute'
     WHERE id=$1`,
    [pendingId],
  );
  const expired = await post("/api/broker/github", { action: "repo.delete", approval_id: pendingId });
  check("nor does an expired one", 403, expired.status);

  // And even correctly approved, nothing is executed.
  await pool.query(
    "UPDATE approvals SET state='approved', expires_at=now()+interval '1 hour' WHERE id=$1",
    [pendingId],
  );
  const approved = await post("/api/broker/github", {
    action: "repo.delete",
    approval_id: pendingId,
  });
  check("with a live approval it still does not execute the deletion", 501, approved.status);

  // "No execution" has to be observable, not asserted. The broker audits every
  // capability it actually resolves, so the absence of one for a delete is the
  // evidence that nothing was carried out.
  const invoked = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_events
     WHERE action='broker.invoke' AND target LIKE '%delete%'`,
  );
  check("and no delete was ever brokered", "0", invoked.rows[0].n);

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => {
    console.error(err);
    fail += 1;
  })
  .finally(async () => {
    await removeFixtures(pool, created);
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

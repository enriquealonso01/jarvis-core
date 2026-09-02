/**
 * A fixture project can open its own pull request.
 *
 * The S28 parity run pushed its branch and then parked at the PR step with
 * `[github] no API credential for this project's pull requests`, status
 * waiting_for_user. It read like a real request to Enrique, and it was not: the
 * project was `s28-parity-ki3ygo`, a throwaway repository created minutes
 * earlier by the suite itself. The fixture provisioned a deploy key and an
 * allowlist and forgot the API credential, which three other suites each
 * remember in their own copied code.
 *
 * Asserted against the real precondition in `src/pullrequest.ts` rather than
 * against the column, so this fails for the same reason the run did.
 */
import { createPool } from "../src/db.js";
import { giveProjectApiCredential } from "./lib/projectcred.js";
import { readJsonCredential } from "../src/credentials.js";

const pool = createPool();
let fails = 0;
const ok = (m: string) => console.log(`  ok   - ${m}`);
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails++; };

/** The exact check `openPullRequest` makes before it tries. */
async function canOpenPr(projectId: string): Promise<{ ok: boolean; why: string }> {
  const r = await pool.query<{ cred: string | null }>(
    `SELECT github_api_credential_id AS cred FROM projects WHERE id = $1`,
    [projectId],
  );
  const cred = r.rows[0]?.cred;
  if (!cred) return { ok: false, why: "no GitHub API credential" };
  const payload = await readJsonCredential(pool, cred).catch(() => null);
  const token = payload?.api_key ?? payload?.token ?? "";
  return token ? { ok: true, why: "has a readable token" } : { ok: false, why: "credential has no token" };
}

async function main() {
  /*
   * Refuse to run without the credential this copies from.
   *
   * In a dev database with no credentials the helper throws, and the failure
   * surfaced as a bare `{}` - which says nothing and looks like a bug in the
   * code under test rather than a missing prerequisite. Naming it is the
   * difference between a five-second diagnosis and a wrong one.
   */
  const admin = await pool.query<{ c: string | null }>(
    `SELECT credential_id AS c FROM auth_profiles WHERE id = 'github_personal_admin'`,
  );
  if (!admin.rows[0]?.c) {
    console.log("  SKIP - github_personal_admin has no credential here; run this where one exists");
    console.log("Project API credential SKIPPED");
    process.exit(2);
  }

  const slug = `credfixture-${Date.now()}`;
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, project_type, github_owner, github_repo)
     VALUES ($1, $1, 'personal', 'enriquealonso01', $1) RETURNING id`,
    [slug],
  );
  const pid = p.rows[0].id;

  console.log("1. without a credential the PR step cannot proceed");
  const before = await canOpenPr(pid);
  !before.ok ? ok(`refused: ${before.why}`) : bad("a project with no credential claimed it could open a PR");

  console.log("2. the shared helper gives the project its own credential");
  const credId = await giveProjectApiCredential(pool, pid, slug);
  const after = await canOpenPr(pid);
  after.ok ? ok(after.why) : bad(`still cannot open a PR: ${after.why}`);

  console.log("3. the credential belongs to the project, not to the admin profile");
  // The isolation that matters: the project holds its OWN row. It must not be
  // pointed at the admin profile's credential, which reaches every repository
  // on the account.
  const adminCred = await pool.query<{ c: string | null }>(
    `SELECT credential_id AS c FROM auth_profiles WHERE id = 'github_personal_admin'`,
  );
  /*
   * Read what the PROJECT points at, not what the helper returned.
   *
   * The first version compared the helper's return value against the admin
   * credential - and passed under a sabotage that pointed the project column
   * straight at the admin row, because the helper went on returning the id of
   * the row it had created. The assertion has to look where the isolation
   * actually lives, which is the column the broker reads.
   */
  const pointed = await pool.query<{ cred: string | null }>(
    `SELECT github_api_credential_id AS cred FROM projects WHERE id = $1`, [pid],
  );
  const at = pointed.rows[0]?.cred;
  at === credId
    ? ok("the project points at its own new row")
    : bad(`the project points at ${at}, not the row that was created for it`);
  at !== adminCred.rows[0]?.c
    ? ok("and not at the admin credential")
    : bad("the project was pointed straight at the admin credential");

  const fp = await pool.query<{ fingerprint: string }>(
    `SELECT fingerprint FROM credentials WHERE id = $1`, [credId],
  );
  fp.rows[0]?.fingerprint === `project:${slug}:github`
    ? ok(`fingerprinted ${fp.rows[0].fingerprint}`)
    : bad(`fingerprint is ${fp.rows[0]?.fingerprint}`);

  await pool.query(`UPDATE projects SET github_api_credential_id = NULL WHERE id = $1`, [pid]);
  await pool.query(`DELETE FROM credentials WHERE id = $1`, [credId]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [pid]);
  await pool.end();

  console.log(fails === 0 ? "\nProject API credential PASS" : `\nProject API credential FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

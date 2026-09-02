import type pg from "pg";
import { encryptGcm, loadMasterKey, newDek, wrapDek } from "../../src/crypto.js";
import { readJsonCredential } from "../../src/credentials.js";

/**
 * Give a fixture project its OWN GitHub API credential row.
 *
 * A deploy key pushes a branch; it cannot open a pull request. A project with
 * no `github_api_credential_id` therefore parks at the PR step with a ticket
 * asking Enrique to add one - which is right for a real project and wrong for a
 * disposable fixture, where it asks him to mint a token for a repository that
 * will be deleted minutes later. That is exactly what happened: the S28 parity
 * fixture provisioned a deploy key and an allowlist, forgot this, and the
 * resulting ticket sat in `waiting_for_user` looking like a real request.
 *
 * It lives here, in one place, because three suites had already grown their own
 * identical copy of it and the fourth is how the gap appeared. A fifth will now
 * import it.
 *
 * The row holds the same secret as the admin PAT, because a GitHub fine-grained
 * token is account-scoped and Enrique has one. That is a real limitation, and
 * it is written down rather than papered over: what the code enforces is that a
 * project owns its credential row and cannot reach the admin PROFILE through
 * the broker. Per-repository tokens would make the secrets differ too.
 */
export async function giveProjectApiCredential(
  pool: pg.Pool,
  projectId: string,
  label: string,
): Promise<string> {
  const admin = await pool.query<{ c: string }>(
    `SELECT credential_id AS c FROM auth_profiles WHERE id = 'github_personal_admin'`,
  );
  const adminCred = admin.rows[0]?.c;
  if (!adminCred) throw new Error("github_personal_admin has no credential to copy");
  const token = (await readJsonCredential(pool, adminCred)).api_key;
  if (!token) throw new Error("github_personal_admin credential has no api_key");

  const master = loadMasterKey();
  const dek = newDek();
  const { nonce, ciphertext } = encryptGcm(dek, Buffer.from(JSON.stringify({ api_key: token })));
  const dekRow = await pool.query<{ id: string }>(
    "INSERT INTO dek_keys (wrapped_key) VALUES ($1) RETURNING id",
    [wrapDek(master, dek)],
  );
  const cred = await pool.query<{ id: string }>(
    `INSERT INTO credentials (dek_id, ciphertext, nonce, fingerprint, kind, broker_only)
     VALUES ($1, $2, $3, $4, 'api_key', false) RETURNING id`,
    [dekRow.rows[0].id, ciphertext, nonce, `project:${label}:github`],
  );
  await pool.query(
    `UPDATE projects SET github_api_credential_id = $2 WHERE id = $1`,
    [projectId, cred.rows[0].id],
  );
  return cred.rows[0].id;
}

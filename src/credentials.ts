import type pg from "pg";
import { encryptGcm, loadMasterKey, newDek, unwrapDek, wrapDek, decryptGcm } from "./crypto.js";

export async function storeJsonCredential(
  pool: pg.Pool,
  args: {
    kind: string;
    payload: Record<string, string>;
    fingerprint: string;
    brokerOnly: boolean;
    /** Null for a credential that belongs to a project rather than to Jarvis. */
    authProfileId: string | null;
    connectionSlug?: string;
    /** Set to create/point a PROJECT-scoped connection instead of a system one. */
    projectId?: string | null;
    replace?: boolean;
  },
): Promise<{ credentialId: string; fingerprint: string }> {
  if (args.authProfileId) {
    const existing = await pool.query<{ credential_id: string | null }>(
      "SELECT credential_id FROM auth_profiles WHERE id = $1",
      [args.authProfileId],
    );
    if (existing.rows[0]?.credential_id && !args.replace) {
      return { credentialId: existing.rows[0].credential_id, fingerprint: args.fingerprint };
    }
  }

  const master = loadMasterKey();
  const dek = newDek();
  const wrapped = wrapDek(master, dek);
  const { nonce, ciphertext } = encryptGcm(dek, Buffer.from(JSON.stringify(args.payload), "utf8"));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dekRow = await client.query<{ id: string }>(
      "INSERT INTO dek_keys (wrapped_key) VALUES ($1) RETURNING id",
      [wrapped],
    );
    const cred = await client.query<{ id: string }>(
      `INSERT INTO credentials (dek_id, ciphertext, nonce, fingerprint, kind, broker_only)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [dekRow.rows[0].id, ciphertext, nonce, args.fingerprint, args.kind, args.brokerOnly],
    );
    const credentialId = cred.rows[0].id;
    if (args.authProfileId) {
      await client.query(
        `UPDATE auth_profiles
         SET credential_id = $2, health = 'healthy'
         WHERE id = $1`,
        [args.authProfileId, credentialId],
      );
    }
    if (args.connectionSlug) {
      // A project credential may be the first of its kind, so the connection is
      // created if it is not there. Scoped to the project either way — a token
      // for one repository must never end up on a shared connection, which is
      // the whole reason it exists rather than reusing the admin token.
      await client.query(
        `INSERT INTO connections (slug, kind, scope, project_id, credential_id, health, last_tested_at)
         VALUES ($1, 'api', $3, $4, $2, 'healthy', now())
         ON CONFLICT (slug) DO UPDATE
           SET credential_id = EXCLUDED.credential_id, health = 'healthy',
               last_tested_at = now(),
               project_id = COALESCE(EXCLUDED.project_id, connections.project_id)`,
        [args.connectionSlug, credentialId, args.projectId ? "project" : "system", args.projectId ?? null],
      );
    }
    await client.query(
      `INSERT INTO audit_events (actor, action, target, metadata)
       VALUES ('bootstrap', 'credential.store', $1, $2)`,
      [
        args.authProfileId ?? args.connectionSlug ?? "unknown",
        JSON.stringify({ fingerprint: args.fingerprint, kind: args.kind, project_id: args.projectId ?? null }),
      ],
    );
    await client.query("COMMIT");
    return { credentialId, fingerprint: args.fingerprint };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function readJsonCredential(
  pool: pg.Pool,
  credentialId: string,
): Promise<Record<string, string>> {
  const row = await pool.query<{
    wrapped_key: Buffer;
    ciphertext: Buffer;
    nonce: Buffer;
  }>(
    `SELECT d.wrapped_key, c.ciphertext, c.nonce
     FROM credentials c JOIN dek_keys d ON d.id = c.dek_id
     WHERE c.id = $1`,
    [credentialId],
  );
  const cred = row.rows[0];
  if (!cred) throw new Error("credential not found");
  const dek = unwrapDek(loadMasterKey(), Buffer.from(cred.wrapped_key));
  const plain = decryptGcm(dek, Buffer.from(cred.nonce), Buffer.from(cred.ciphertext));
  return JSON.parse(plain.toString("utf8")) as Record<string, string>;
}

/**
 * S5 — deploy-key isolation, proved against a real SSH server.
 *
 * L6's own wording is "two personal repos": two private GitHub repositories,
 * two deploy keys, and worker A unable to reach B. The GitHub half is blocked
 * on a token permission (see BLOCKED.md), so this proves the half S5 actually
 * owns — that Jarvis materialises a per-project key, uses that key and no
 * other, and cannot reach a repository the key is not authorised for.
 *
 * It is not a mock. `sshgit` is a real sshd with two users, one repository
 * each, and one authorized key each; the cross-project failure is sshd refusing
 * the connection, not this file deciding it should.
 *
 * What it does NOT prove: anything about GitHub. S5 stays PARTIAL until the
 * token can create the two private repos L6 names.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createPool } from "../src/db.js";
import { encryptGcm, loadMasterKey, newDek, wrapDek } from "../src/crypto.js";
import {
  ensureProjectCheckout,
  gitEnv,
  loadProject,
  materialiseDeployKey,
  repoDir,
} from "../src/checkout.js";
import { checkConnectionAccess, recordDenial } from "../src/isolation.js";
import { PROJECTS_DIR } from "../src/paths.js";
import { readJsonCredential } from "../src/credentials.js";

const run = promisify(execFile);

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

const pool = createPool();
const HOST = process.env.SSHGIT_HOST ?? "sshgit";
const KEYS = process.env.SSHGIT_KEYS ?? "/keys";

/** Generate a real OpenSSH keypair, the same way github.ts does. */
async function keypair(comment: string): Promise<{ priv: string; pub: string; fp: string }> {
  const dir = await fs.mkdtemp("/tmp/s5key-");
  const f = path.join(dir, "id_ed25519");
  await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment, "-f", f, "-q"]);
  const priv = await fs.readFile(f, "utf8");
  const pub = (await fs.readFile(`${f}.pub`, "utf8")).trim();
  const { stdout } = await run("ssh-keygen", ["-lf", `${f}.pub`]);
  await fs.rm(dir, { recursive: true, force: true });
  return { priv, pub, fp: stdout.trim().split(/\s+/)[1] };
}

/** Store a deploy key the way githubProvisionDeployKey does, minus GitHub. */
async function storeDeployKey(
  projectId: string,
  kp: { priv: string; pub: string; fp: string },
): Promise<string> {
  const master = loadMasterKey();
  const dek = newDek();
  const wrapped = wrapDek(master, dek);
  const { nonce, ciphertext } = encryptGcm(
    dek,
    Buffer.from(JSON.stringify({ private_key_openssh: kp.priv, public_key_openssh: kp.pub })),
  );
  const dekRow = await pool.query<{ id: string }>(
    "INSERT INTO dek_keys (wrapped_key) VALUES ($1) RETURNING id",
    [wrapped],
  );
  const cred = await pool.query<{ id: string }>(
    `INSERT INTO credentials (dek_id, ciphertext, nonce, fingerprint, kind, broker_only)
     VALUES ($1,$2,$3,$4,'deploy_key',false) RETURNING id`,
    [dekRow.rows[0].id, ciphertext, nonce, kp.fp],
  );
  await pool.query(`UPDATE projects SET deploy_key_credential_id = $2 WHERE id = $1`, [
    projectId,
    cred.rows[0].id,
  ]);
  return cred.rows[0].id;
}

/** Read back the key phase 1 stored, so phase 2 uses the authorised one. */
async function existingKey(projectId: string): Promise<{ priv: string; pub: string; fp: string }> {
  const p = await loadProject(pool, projectId);
  if (!p?.deploy_key_credential_id) throw new Error("run phase 1 first (S5_KEYS_ONLY=1)");
  const payload = await readJsonCredential(pool, p.deploy_key_credential_id);
  const fp = (
    await pool.query<{ fingerprint: string }>(`SELECT fingerprint FROM credentials WHERE id=$1`, [
      p.deploy_key_credential_id,
    ])
  ).rows[0].fingerprint;
  return { priv: payload.private_key_openssh, pub: payload.public_key_openssh, fp };
}

async function project(slug: string, sshUser: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, project_type, confidentiality, github_owner, github_repo, default_branch)
     VALUES ($1,$1,'personal','normal',$2,$3,'main')
     ON CONFLICT (slug) DO UPDATE SET github_owner=EXCLUDED.github_owner,
       github_repo=EXCLUDED.github_repo, archived_at=NULL
     RETURNING id`,
    [slug, sshUser, `${sshUser}.git`],
  );
  return r.rows[0].id;
}

/** ls-remote against the local host, using only this project's key. */
async function lsRemoteLocal(
  projectId: string,
  sshUser: string,
): Promise<{ ok: boolean; error?: string }> {
  const p = await loadProject(pool, projectId);
  const key = await materialiseDeployKey(pool, p!);
  if ("error" in key) return { ok: false, error: key.error };
  try {
    await run("git", ["ls-remote", `${sshUser}@${HOST}:${sshUser}.git`], {
      env: gitEnv(key.sshCommand),
      timeout: 30_000,
    });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, error: (e.stderr || e.message || "").trim() };
  }
}

async function main(): Promise<void> {
  // Deterministic, because this test runs in two phases: phase 1 generates the
  // keys and authorises them on the server, phase 2 uses them. Timestamped slugs
  // meant phase 2 made NEW keys the server had never been told about, and every
  // "can reach its own repo" assertion failed for the wrong reason.
  const aSlug = "iso-alpha";
  const bSlug = "iso-beta";

  console.log("=== two projects, two keys ===");
  const aId = await project(aSlug, "alpha");
  const bId = await project(bSlug, "beta");
  const fresh = process.env.S5_KEYS_ONLY === "1";
  const aKp = fresh ? await keypair(`jarvis-${aSlug}`) : await existingKey(aId);
  const bKp = fresh ? await keypair(`jarvis-${bSlug}`) : await existingKey(bId);
  if (fresh) {
    await storeDeployKey(aId, aKp);
    await storeDeployKey(bId, bKp);
  }
  console.log(`  A ${aKp.fp}`);
  console.log(`  B ${bKp.fp}`);
  truthy("alpha's fingerprint is a real SHA256 fingerprint", aKp.fp.startsWith("SHA256:"));
  truthy("beta's fingerprint is a real SHA256 fingerprint", bKp.fp.startsWith("SHA256:"));
  check("the two fingerprints differ", true, aKp.fp !== bKp.fp);
  check(
    "and the database holds two distinct deploy-key credentials",
    2,
    Number(
      (
        await pool.query<{ n: string }>(
          `SELECT count(DISTINCT deploy_key_credential_id)::text AS n FROM projects WHERE id IN ($1,$2)`,
          [aId, bId],
        )
      ).rows[0].n,
    ),
  );

  // The server only learns a key when the test authorises it — one key per user.
  await fs.mkdir(KEYS, { recursive: true });
  await fs.writeFile(path.join(KEYS, "alpha.pub"), `${aKp.pub}\n`);
  await fs.writeFile(path.join(KEYS, "beta.pub"), `${bKp.pub}\n`);
  console.log("  authorized keys written; restart sshgit before the next section");

  console.log("\n=== the key on disk ===");
  const mat = await materialiseDeployKey(pool, (await loadProject(pool, aId))!);
  if ("error" in mat) throw new Error(mat.error);
  const st = await fs.stat(mat.keyFile);
  check("the private key is 0600", "600", (st.mode & 0o777).toString(8));
  check(
    "and it lives under its own project's directory",
    true,
    mat.keyFile.startsWith(path.join(PROJECTS_DIR, aSlug)),
  );
  truthy("ssh is told to use that key and nothing else", mat.sshCommand.includes("IdentitiesOnly=yes"));
  truthy("and not to fall back to an agent", mat.sshCommand.includes("IdentityAgent=none"));
  truthy("and never to prompt", mat.sshCommand.includes("BatchMode=yes"));

  if (process.env.S5_KEYS_ONLY === "1") {
    console.log(`\n==== ${pass} passed, ${fail} failed (keys phase) ====`);
    return;
  }

  console.log("\n=== each project reaches its own repository ===");
  const aOwn = await lsRemoteLocal(aId, "alpha");
  const bOwn = await lsRemoteLocal(bId, "beta");
  console.log(`  A->A ${JSON.stringify(aOwn).slice(0, 160)}`);
  check("alpha can reach alpha", true, aOwn.ok);
  check("beta can reach beta", true, bOwn.ok);

  console.log("\n=== THE ISOLATION ASSERTION ===");
  const cross = await lsRemoteLocal(aId, "beta");
  console.log(`  A->B ${JSON.stringify(cross).slice(0, 240)}`);
  check("alpha CANNOT reach beta", false, cross.ok);
  truthy(
    "and it failed at authentication, not at something incidental",
    /Permission denied|publickey|fatal: Could not read/.test(cross.error ?? ""),
  );

  console.log("\n=== the checkout really lands on disk ===");
  // Own the state: a checkout left by an earlier run makes ensureProjectCheckout
  // take the fetch path, and "the clone is audited" then asserts a clone that
  // legitimately did not happen.
  await fs.rm(repoDir(aSlug), { recursive: true, force: true });
  await pool.query(`DELETE FROM audit_events WHERE action='project.checkout.clone' AND project_id=$1`, [aId]);
  // JARVIS_GIT_URL_TEMPLATE points the checkout at the local SSH host.
  const aOut = await ensureProjectCheckout(pool, aId);
  console.log(`  ${JSON.stringify(aOut)}`);
  check("alpha cloned", true, aOut.ok);
  truthy(
    "alpha's repo is really there",
    await fs.stat(path.join(repoDir(aSlug), ".git")).then(() => true, () => false),
  );
  truthy(
    "with the seeded content",
    await fs.readFile(path.join(repoDir(aSlug), "README.md"), "utf8")
      .then((t) => t.includes("alpha repository"), () => false),
  );
  check(
    "the clone is audited",
    1,
    Number(
      (
        await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM audit_events WHERE action='project.checkout.clone' AND project_id=$1`,
          [aId],
        )
      ).rows[0].n,
    ),
  );

  console.log("\n=== a project cannot reach the GitHub admin credential ===");
  const decision = await checkConnectionAccess(pool, {
    connectionSlug: "github_personal_admin",
    projectId: aId,
    capability: "git.push",
  });
  console.log(`  ${JSON.stringify(decision)}`);
  check("denied", false, decision.allowed);
  if (!decision.allowed) {
    check("denied as an isolation breach", "security.isolation", decision.code);
    const before = Number(
      (await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events WHERE action='security.isolation' AND project_id=$1`,
        [aId],
      )).rows[0].n,
    );
    await recordDenial(pool, {
      denial: decision,
      capability: "git.push",
      projectId: aId,
      connectionSlug: "github_personal_admin",
    });
    const after = Number(
      (await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events WHERE action='security.isolation' AND project_id=$1`,
        [aId],
      )).rows[0].n,
    );
    check("and the denial is audited", before + 1, after);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => {
    console.error(err);
    fail += 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

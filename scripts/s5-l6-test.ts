/**
 * L6 — two personal repos, isolated (plan S5).
 *
 * This one cannot be faked. Deploy-key isolation is a property of a real SSH
 * host: whether project A's key can reach project B's repo is decided by
 * GitHub, not by anything in this codebase. So it runs against real private
 * repos, creates real keys, and the isolation assertion is a real `git
 * ls-remote` that must FAIL.
 *
 *   node --import tsx scripts/s5-l6-test.ts          # run it
 *   JARVIS_L6_KEEP=1 node ... scripts/s5-l6-test.ts  # leave the repos behind
 *
 * Repos are created private, used, and deleted again. If the run dies partway,
 * the names are printed so they can be removed by hand.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createPool } from "../src/db.js";
import { githubCreatePrivateRepo, githubProvisionDeployKey } from "../src/github.js";
import { ensureProjectCheckout, lsRemote, materialiseDeployKey, loadProject, repoDir } from "../src/checkout.js";
import { checkConnectionAccess, recordDenial } from "../src/isolation.js";
import { readJsonCredential } from "../src/credentials.js";
import { PROJECTS_DIR } from "../src/paths.js";

let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));

const pool = createPool();
const stamp = Date.now().toString(36);
const created: { owner: string; repo: string }[] = [];

async function deleteRepo(owner: string, repo: string): Promise<void> {
  const cred = await pool.query<{ credential_id: string }>(
    `SELECT credential_id FROM auth_profiles WHERE id = 'github_personal_admin'`,
  );
  const id = cred.rows[0]?.credential_id;
  if (!id) return;
  const payload = await readJsonCredential(pool, id);
  const token = payload.api_key ?? payload.token ?? "";
  await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "jarvis-core",
    },
  }).catch(() => undefined);
}

async function makeProject(slug: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, project_type, confidentiality, default_branch)
     VALUES ($1, $1, 'personal', 'normal', 'main')
     ON CONFLICT (slug) DO UPDATE SET archived_at = NULL
     RETURNING id`,
    [slug],
  );
  return r.rows[0].id;
}

async function main(): Promise<void> {
  const aSlug = `l6-alpha-${stamp}`;
  const bSlug = `l6-beta-${stamp}`;
  console.log(`L6: ${aSlug} / ${bSlug}`);

  const aId = await makeProject(aSlug);
  const bId = await makeProject(bSlug);

  console.log("\n=== two private repos ===");
  const aRepo = await githubCreatePrivateRepo(pool, aSlug);
  const bRepo = await githubCreatePrivateRepo(pool, bSlug);
  if ("error" in aRepo) throw new Error(`alpha repo: ${aRepo.error}`);
  if ("error" in bRepo) throw new Error(`beta repo: ${bRepo.error}`);
  created.push({ owner: aRepo.owner, repo: aRepo.name }, { owner: bRepo.owner, repo: bRepo.name });
  console.log(`  ${aRepo.full_name} / ${bRepo.full_name}`);
  ok("both repos created private");
  check(
    "repo creation is audited",
    2,
    Number(
      (
        await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM audit_events
           WHERE action = 'github.admin.create_private_repository'
             AND target IN ($1, $2)`,
          [aRepo.full_name, bRepo.full_name],
        )
      ).rows[0].n,
    ),
  );

  console.log("\n=== two deploy keys, two fingerprints ===");
  const aKey = await githubProvisionDeployKey(pool, aId, aRepo.owner, aRepo.name);
  const bKey = await githubProvisionDeployKey(pool, bId, bRepo.owner, bRepo.name);
  if ("error" in aKey) throw new Error(`alpha key: ${aKey.error}`);
  if ("error" in bKey) throw new Error(`beta key: ${bKey.error}`);
  console.log(`  A ${aKey.fingerprint}`);
  console.log(`  B ${bKey.fingerprint}`);
  truthy("alpha's fingerprint is a real SHA256 fingerprint", aKey.fingerprint.startsWith("SHA256:"));
  truthy("beta's fingerprint is a real SHA256 fingerprint", bKey.fingerprint.startsWith("SHA256:"));
  check("the two fingerprints differ", true, aKey.fingerprint !== bKey.fingerprint);
  check("and so do the credential rows", true, aKey.deployKeyId !== bKey.deployKeyId);
  check(
    "key registration is audited for both",
    2,
    Number(
      (
        await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM audit_events
           WHERE action = 'github.deploy_key.register' AND project_id IN ($1, $2)`,
          [aId, bId],
        )
      ).rows[0].n,
    ),
  );

  console.log("\n=== each project clones its own repo, with its own key ===");
  const aOut = await ensureProjectCheckout(pool, aId);
  const bOut = await ensureProjectCheckout(pool, bId);
  console.log(`  A: ${JSON.stringify(aOut)}`);
  console.log(`  B: ${JSON.stringify(bOut)}`);
  check("alpha cloned", true, aOut.ok);
  check("beta cloned", true, bOut.ok);
  truthy(
    "alpha's repo is really on disk",
    await fs.stat(path.join(repoDir(aSlug), ".git")).then(() => true, () => false),
  );
  truthy(
    "beta's repo is really on disk",
    await fs.stat(path.join(repoDir(bSlug), ".git")).then(() => true, () => false),
  );
  check(
    "and each lives under its own project directory",
    true,
    repoDir(aSlug).startsWith(path.join(PROJECTS_DIR, aSlug)) &&
      repoDir(bSlug).startsWith(path.join(PROJECTS_DIR, bSlug)),
  );

  console.log("\n--- the key on disk is only readable by its owner ---");
  const aProject = await loadProject(pool, aId);
  const mat = await materialiseDeployKey(pool, aProject!);
  if ("error" in mat) throw new Error(mat.error);
  const st = await fs.stat(mat.keyFile);
  check("the private key is 0600", "600", (st.mode & 0o777).toString(8));
  truthy("ssh is told to use that key and nothing else", mat.sshCommand.includes("IdentitiesOnly=yes"));
  truthy("and not to fall back to an agent", mat.sshCommand.includes("IdentityAgent=none"));

  console.log("\n=== THE ISOLATION ASSERTION: A must not reach B ===");
  const cross = await lsRemote(pool, aId, bRepo.owner, bRepo.name);
  console.log(`  A -> B: ${JSON.stringify(cross).slice(0, 220)}`);
  check("alpha CANNOT ls-remote beta", false, cross.ok);
  const own = await lsRemote(pool, aId, aRepo.owner, aRepo.name);
  check("but alpha CAN reach its own repo (so the failure means something)", true, own.ok);
  const crossBack = await lsRemote(pool, bId, aRepo.owner, aRepo.name);
  check("and beta cannot reach alpha either", false, crossBack.ok);

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
      (
        await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM audit_events WHERE action = 'security.isolation' AND project_id = $1`,
          [aId],
        )
      ).rows[0].n,
    );
    await recordDenial(pool, {
      denial: decision,
      capability: "git.push",
      projectId: aId,
      connectionSlug: "github_personal_admin",
    });
    const after = Number(
      (
        await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM audit_events WHERE action = 'security.isolation' AND project_id = $1`,
          [aId],
        )
      ).rows[0].n,
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
    if (!process.env.JARVIS_L6_KEEP) {
      for (const r of created) {
        await deleteRepo(r.owner, r.repo);
        console.log(`cleaned up ${r.owner}/${r.repo}`);
      }
    } else {
      console.log("kept:", created.map((r) => `${r.owner}/${r.repo}`).join(", "));
    }
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

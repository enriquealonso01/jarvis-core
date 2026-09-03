import crypto from "node:crypto";
import type pg from "pg";
import { readJsonCredential } from "./credentials.js";
import { audit } from "./audit.js";
import { encryptGcm, loadMasterKey, newDek, wrapDek } from "./crypto.js";

async function adminToken(pool: pg.Pool): Promise<string> {
  const row = await pool.query<{ credential_id: string }>(
    "SELECT credential_id FROM auth_profiles WHERE id = 'github_personal_admin' AND credential_id IS NOT NULL",
  );
  if (!row.rows[0]) throw new Error("github_personal_admin credential missing");
  const cred = await readJsonCredential(pool, row.rows[0].credential_id);
  const token = cred.api_key;
  if (!token) throw new Error("github_personal_admin api_key missing");
  return token;
}

/**
 * Give a project its OWN GitHub API credential row.
 *
 * A deploy key pushes a branch; it cannot open a pull request. A project with
 * no `github_api_credential_id` therefore parks at the PR step with a ticket
 * asking Enrique to add one - correct for a real project, and the reason an
 * API-onboarded project could get all the way to a finished branch and then
 * stop. The bench path has minted this for its fixtures for a while; the API
 * path never did, which is the whole of front-door bug #3.
 *
 * Idempotent on purpose: linking a repo is a step an operator may repeat, and
 * a second call must not leave a second credential row behind. The existing id
 * is returned untouched.
 *
 * The row holds the same secret as the admin PAT, because a GitHub
 * fine-grained token is account-scoped and Enrique has one. That is a real
 * limitation, written down rather than papered over: what this enforces is
 * that a project owns its credential ROW and cannot reach the admin PROFILE
 * through the broker. Per-repository tokens would make the secrets differ too.
 */
export async function githubProvisionApiCredential(
  pool: pg.Pool,
  projectId: string,
  label: string,
): Promise<string> {
  const existing = await pool.query<{ c: string | null }>(
    "SELECT github_api_credential_id AS c FROM projects WHERE id = $1",
    [projectId],
  );
  const already = existing.rows[0]?.c;
  if (already) return already;

  const token = await adminToken(pool);
  const master = loadMasterKey();
  const dek = newDek();
  const { nonce, ciphertext } = encryptGcm(
    dek,
    Buffer.from(JSON.stringify({ api_key: token }), "utf8"),
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dekRow = await client.query<{ id: string }>(
      "INSERT INTO dek_keys (wrapped_key) VALUES ($1) RETURNING id",
      [wrapDek(master, dek)],
    );
    const cred = await client.query<{ id: string }>(
      `INSERT INTO credentials (dek_id, ciphertext, nonce, fingerprint, kind, broker_only)
       VALUES ($1, $2, $3, $4, 'api_key', false) RETURNING id`,
      [dekRow.rows[0].id, ciphertext, nonce, `project:${label}:github`],
    );
    const credentialId = cred.rows[0].id;

    await client.query("UPDATE projects SET github_api_credential_id = $2 WHERE id = $1", [
      projectId,
      credentialId,
    ]);

    await client.query("COMMIT");
    // Audited through the one helper rather than a hand-written INSERT. That
    // costs atomicity - `audit` takes the pool, so the row lands just after the
    // commit rather than inside it - and the S12b sweep is deliberate that the
    // count of hand-written INSERTs may fall and may not rise. `audit` never
    // throws and logs loudly, so the failure mode is a logged missing row
    // rather than a lost credential.
    await audit(pool, {
      actor: "broker",
      action: "github.api_credential.provision",
      target: label,
      projectId,
      outcome: "allowed",
      extra: { credential_id: credentialId },
    });
    return credentialId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function githubCreatePrivateRepo(
  pool: pg.Pool,
  name: string,
): Promise<{ full_name: string; owner: string; name: string; id: number; default_branch: string } | { error: string }> {
  let token: string;
  try {
    token = await adminToken(pool);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "admin token error" };
  }
  const res = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarvis-core",
    },
    body: JSON.stringify({ name, private: true, auto_init: true }),
  });
  if (!res.ok) {
    return { error: `github API ${res.status}` };
  }
  const json = (await res.json()) as {
    full_name: string;
    name: string;
    owner: { login: string };
    id: number;
    default_branch: string;
  };
  await pool.query(
    `INSERT INTO audit_events (actor, action, target, metadata)
     VALUES ('broker', 'github.admin.create_private_repository', $1, $2)`,
    [json.full_name, JSON.stringify({ name, repo_id: json.id })],
  );
  return {
    full_name: json.full_name,
    owner: json.owner.login,
    name: json.name,
    id: json.id,
    default_branch: json.default_branch || "main",
  };
}


/**
 * An ed25519 keypair in OpenSSH format, plus its real SHA256 fingerprint.
 *
 * Shelling out to ssh-keygen rather than hand-encoding the OpenSSH private key
 * format: the format is fiddly, getting it subtly wrong fails at `git clone`
 * rather than at generation, and this is exactly the kind of code that should
 * not have a clever version.
 */
async function generateOpenSshKey(
  comment: string,
): Promise<{ publicKey: string; privateKey: string; fingerprint: string } | { error: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const run = promisify(execFile);

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-key-"));
  const file = path.join(dir, "id_ed25519");
  try {
    await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment, "-f", file, "-q"]);
    const privateKey = await fsp.readFile(file, "utf8");
    const publicKey = (await fsp.readFile(`${file}.pub`, "utf8")).trim();
    const { stdout } = await run("ssh-keygen", ["-lf", `${file}.pub`]);
    // "256 SHA256:abc... comment (ED25519)" -> "SHA256:abc..."
    const fingerprint = stdout.trim().split(/\s+/)[1] ?? "";
    if (!fingerprint.startsWith("SHA256:")) {
      return { error: `could not read the key fingerprint: ${stdout.trim().slice(0, 120)}` };
    }
    return { publicKey, privateKey, fingerprint };
  } catch (err) {
    return { error: `ssh-keygen failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function githubProvisionDeployKey(
  pool: pg.Pool,
  projectId: string,
  owner: string,
  repo: string,
): Promise<{ deployKeyId: string; fingerprint: string } | { error: string }> {
  let token: string;
  try {
    token = await adminToken(pool);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "admin token error" };
  }

  // Generate a real OpenSSH keypair.
  //
  // This used to be `crypto.generateKeyPairSync` with PEM/SPKI encoding, which
  // produces something GitHub will not accept as a deploy key and `ssh -i` will
  // not use. `ssh-keygen` produces both halves in the only formats that matter
  // here, and reports the fingerprint GitHub itself shows — so "two projects,
  // two different fingerprints" is comparing the same thing a human would.
  const gen = await generateOpenSshKey(`jarvis-${projectId.slice(0, 8)}`);
  if ("error" in gen) return gen;
  const { publicKey, privateKey, fingerprint } = gen;

  // Register public deploy key on GitHub repo
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarvis-core",
    },
    body: JSON.stringify({
      title: `jarvis-${projectId.slice(0, 8)}`,
      key: publicKey,
      read_only: false,
    }),
  });
  if (!res.ok) {
    return { error: `github deploy key register failed status=${res.status}` };
  }

  // Encrypt private key and store in credentials table
  const master = loadMasterKey();
  const dek = newDek();
  const wrapped = wrapDek(master, dek);
  const payload = {
    private_key_openssh: privateKey,
    public_key_openssh: publicKey,
  };
  const { nonce, ciphertext } = encryptGcm(dek, Buffer.from(JSON.stringify(payload), "utf8"));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dekRow = await client.query<{ id: string }>(
      "INSERT INTO dek_keys (wrapped_key) VALUES ($1) RETURNING id",
      [wrapped],
    );
    const cred = await client.query<{ id: string }>(
      `INSERT INTO credentials (dek_id, ciphertext, nonce, fingerprint, kind, broker_only)
       VALUES ($1, $2, $3, $4, 'deploy_key', false) RETURNING id`,
      [dekRow.rows[0].id, ciphertext, nonce, fingerprint],
    );
    const credentialId = cred.rows[0].id;

    await client.query(
      `UPDATE projects
       SET deploy_key_credential_id = $2,
           github_owner = $3,
           github_repo = $4
       WHERE id = $1`,
      [projectId, credentialId, owner, repo],
    );

    await client.query(
      `INSERT INTO audit_events (actor, action, target, project_id, metadata)
       VALUES ('broker', 'github.deploy_key.register', $1, $2, $3)`,
      [`${owner}/${repo}`, projectId, JSON.stringify({ fingerprint })],
    );

    await client.query("COMMIT");
    return { deployKeyId: credentialId, fingerprint };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function githubCreatePullRequest(
  pool: pg.Pool,
  args: { owner: string; repo: string; title: string; head: string; base: string; body?: string },
): Promise<{ pr_number: number; html_url: string } | { error: string }> {
  let token: string;
  try {
    token = await adminToken(pool);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "admin token error" };
  }
  const res = await fetch(`https://api.github.com/repos/${args.owner}/${args.repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarvis-core",
    },
    body: JSON.stringify({
      title: args.title,
      head: args.head,
      base: args.base,
      body: args.body ?? "",
    }),
  });
  if (!res.ok) {
    return { error: `github pull request failed status=${res.status}` };
  }
  const json = (await res.json()) as { number: number; html_url: string };
  return { pr_number: json.number, html_url: json.html_url };
}

export async function githubMergePullRequest(
  pool: pg.Pool,
  args: { owner: string; repo: string; pull_number: number; sha?: string },
): Promise<{ merged: boolean; message: string } | { error: string }> {
  let token: string;
  try {
    token = await adminToken(pool);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "admin token error" };
  }
  const res = await fetch(
    `https://api.github.com/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}/merge`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jarvis-core",
      },
      body: JSON.stringify({
        sha: args.sha,
        merge_method: "squash",
      }),
    },
  );
  if (!res.ok) {
    return { error: `github merge failed status=${res.status}` };
  }
  const json = (await res.json()) as { merged: boolean; message: string };
  return { merged: json.merged, message: json.message };
}

/**
 * Commit one file, creating or replacing it.
 *
 * S26 uses this to put the rendered AGENTS.md into a project repository at
 * onboarding. It goes through the broker-only personal admin credential, the
 * same one that creates the repository and registers its deploy key: this runs
 * at project creation, before the project has a credential of its own, and it
 * is a broker operation rather than anything a project worker may do.
 *
 * The GitHub Contents API needs the current blob sha to REPLACE a file and
 * refuses one to CREATE it, so the sha is looked up first and omitted when the
 * file is absent. Sending a stale sha is how a concurrent write gets silently
 * clobbered; sending none against an existing file is a 422.
 */
export async function githubPutFile(
  pool: pg.Pool,
  args: {
    owner: string; repo: string; path: string; content: string;
    message: string; branch?: string;
  },
): Promise<{ commit_sha: string; html_url: string } | { error: string }> {
  let token: string;
  try {
    token = await adminToken(pool);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "admin token error" };
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "jarvis-core",
  };
  const base = `https://api.github.com/repos/${args.owner}/${args.repo}/contents/${args.path}`;
  const ref = args.branch ? `?ref=${encodeURIComponent(args.branch)}` : "";

  let sha: string | undefined;
  const existing = await fetch(`${base}${ref}`, { headers });
  if (existing.ok) {
    const json = (await existing.json()) as { sha?: string };
    sha = json.sha;
  } else if (existing.status !== 404) {
    return { error: `github read ${args.path} failed status=${existing.status}` };
  }

  const res = await fetch(base, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: args.message,
      content: Buffer.from(args.content, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
      ...(args.branch ? { branch: args.branch } : {}),
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 200);
    return { error: `github put ${args.path} failed status=${res.status} ${detail}` };
  }
  const json = (await res.json()) as {
    commit?: { sha?: string }; content?: { html_url?: string };
  };
  return {
    commit_sha: json.commit?.sha ?? "",
    html_url: json.content?.html_url ?? "",
  };
}

/**
 * An existing repository, or null when there is none.
 *
 * Exists so a caller can reuse a repository instead of creating one. The
 * benchmark created a fresh private repo per run and nothing deletes them -
 * deleting a repository is irreversible and Enrique's call - so a campaign long
 * enough to be statistically useful would have left dozens behind for someone
 * else to tidy.
 */
export async function githubGetRepo(
  pool: pg.Pool,
  owner: string,
  name: string,
): Promise<{ full_name: string; owner: string; name: string; default_branch: string } | null> {
  const token = await adminToken(pool);
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarvis-core",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github API ${res.status}`);
  const json = (await res.json()) as {
    full_name: string; name: string; owner: { login: string }; default_branch: string;
  };
  return {
    full_name: json.full_name,
    owner: json.owner.login,
    name: json.name,
    default_branch: json.default_branch || "main",
  };
}

/**
 * One file's contents from a repository, at a ref.
 *
 * Used to publish the build bar from the box itself rather than from a
 * workstation over scp. The raw media type is asked for explicitly: the default
 * JSON response base64-encodes the content and caps out on larger files, and a
 * silently truncated PROGRESS.json is worse than a failed publish.
 */
export async function githubReadFile(
  pool: pg.Pool,
  owner: string,
  repo: string,
  filePath: string,
  ref: string,
): Promise<string> {
  const token = await adminToken(pool);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarvis-core",
    },
  });
  if (!res.ok) throw new Error(`github API ${res.status} reading ${filePath}@${ref}`);
  return await res.text();
}

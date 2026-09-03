import type pg from "pg";
import { githubProvisionApiCredential } from "../../src/github.js";

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
 * It lived here, in one place, because three suites had already grown their own
 * identical copy of it and the fourth is how the gap appeared. It is now a thin
 * wrapper over the real thing in src/github.ts: onboarding through the API has
 * to mint this credential too, and a fixture helper and a production path that
 * mint credentials differently is how the two drift apart.
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
  return githubProvisionApiCredential(pool, projectId, label);
}

# ADR 003 — GitHub credential model

- Status: accepted
- Date: 2026-08-31
- Plan sections: §8–10, §76
- Affects isolation / billing / always-confirm: no (implements §10; does not widen access)

## Decision

A GitHub **deploy key cannot open pull requests**. The plan’s “deploy key or equivalently narrow credential” is therefore **two credentials per personal repository**, both created at project bootstrap:

1. **Git write:** a repository-specific read-write SSH deploy key. Private key stored in that project’s secret namespace. Mounted only into that project’s engineering worker (or used via `GIT_SSH_COMMAND` for that cwd). Public key registered on that repo only.
2. **GitHub API:** a repository-scoped credential used **only by the broker** for PRs, checks, merges, and metadata. V1 uses a **fine-grained PAT** (or a GitHub App installation token restricted to that single repository — equivalent). This secret is **not** mounted into browser workers and is **not** a generic `GITHUB_TOKEN` in the coding sandbox unless the task grant requires git+PR in one process; preferred path is typed broker calls (`github.open_pull_request`, etc.).

**System capability `github_personal_admin`:**

- Held only by the broker.
- Allowed actions: create private repository, set default settings, register deploy key, create the repo-scoped API credential, attach repo to the Jarvis project, then stop using admin for that repo’s daily work.
- Never mounted into project workers.
- Never used for a professional project's repositories.

**Professional GitHub:**

- Separate GitHub App or org credential recorded as a **project connection** at onboarding, not at boot.
- Personal admin and personal deploy keys cannot authenticate to that org.
- That credential cannot authenticate to personal repos.

**High-risk actions** (delete, public visibility, transfer, archive-active, weaken branch protection, org-wide perms) stay always-confirm (§13.3, §10.4). Broker refuses them without a bound approval.

**Expiry:** fine-grained PATs expire. Maintenance opens an Issue 14 days before expiry. Rotation is a UserActionRequest unless a GitHub App installation token (short-lived, key stays in broker) is in use — App path is allowed as an equivalent without a product change.

**New personal project bootstrap (broker):**

1. Confirm classification and repo name.
2. Use `github_personal_admin` to create private repo.
3. Generate deploy-key pair; register public key on repo; store private key in project secrets.
4. Create repo-scoped API credential; store in project secrets (broker-only flag).
5. Record `github_owner`, `github_repo`, `github_repo_id`, `default_branch`, `deploy_key_credential_id`, `api_credential_id`.
6. Audit both creations.
7. Admin credential is not referenced on the project allowlist.

## Why

The frozen plan requires repository isolation **and** PR/merge. One SSH deploy key cannot do both. Splitting git vs API matches the plan without granting account-wide access to workers.

## Alternatives rejected

- **One machine SSH key for all repos** — forbidden by §10.2.
- **Account-wide GitHub App token in every worker** — fails §76 (project A must not use the account-level credential).
- **GitHub App only, no deploy keys** — acceptable equivalent if installation is **selected-repo** and workers never see the app private key. If used, document the installation id on the project and skip deploy keys. Default V1 path remains deploy key + repo-scoped API credential because it matches the plan’s wording and is easy to test in §76.

## Consequences

- Coding harnesses push via deploy key; they ask Jarvis to open/merge PRs unless a task grant explicitly allows in-harness `gh` using a **short-lived** broker-minted token for that repo only, injected for that task, revoked after.
- §76 tests must assert two different deploy keys and that A cannot push to B.

## User approval required

No. This is the plan’s preferred isolation, made implementable.

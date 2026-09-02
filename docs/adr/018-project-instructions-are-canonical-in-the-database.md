# ADR 018 — Project instructions are canonical in the database, and the repository gets a rendering

- **Status:** Accepted
- **Date:** 2026-09-02
- **Step:** S26

## Context

S26 writes `AGENTS.md` into a project's repository at onboarding, and its Debug
section leaves one question open on purpose:

> If the committed file and the database disagree, decide which is canonical now
> and enforce it; two sources of project policy is a bug that gets worse with
> time.

They will disagree. The file is in a repository that Enrique edits by hand, that
an engineering task can rewrite mid-run, that a merge can conflict, and that a
`git revert` can take back to a policy nobody currently holds. The database row
in `project_instructions_versions` is written by one code path and versioned.

The question is not which is more convenient to read. It is which one is obeyed
when they differ, because a policy that two sources both claim to define is a
policy nobody can enforce.

## Decision

**The row in `project_instructions_versions` is canonical. The committed
`AGENTS.md` is a rendering of it.**

Concretely:

1. **Onboarding writes the row first.** `project.onboarding_finalize` renders the
   body, writes version 1 with `created_by = 'jarvis'`, and only then is there a
   project whose instructions exist. The commit into the repository follows.
2. **Jarvis reads the row, not the file.** Anything that needs a project's policy
   — routing, gates, the engineering workflow — reads the latest version from the
   database. Nothing parses the working tree to decide what is allowed.
3. **The file is for the humans and the agents inside the repository.** It is
   real and it is meant to be read; a harness working in that checkout should
   follow it. It is not a place to change policy.
4. **An edit to the file is a proposal, not a change.** It reaches Jarvis the way
   any other content Enrique did not author through Jarvis does: as evidence.
   S27 is where a sentence changes policy, and it writes a new version through
   the same path.

## Why not the file

The obvious alternative — the repository is the truth, Jarvis reads `AGENTS.md`
at task start — is attractive because it is how `CLAUDE.md` and friends work, and
because it puts the policy where the work happens.

It fails on three counts here:

- **It has no history Jarvis can answer from.** S27 requires "what changed in
  Alpha's policy last week?" and a rollback that restores the previous version
  *exactly*. Git has that history, but it is per-repository, needs a checkout to
  read, and a project without a repository yet has none at all.
- **It makes the isolation boundary editable from inside the boundary.** A task
  running in a project's worktree can write files in that worktree. If the file
  is canonical, a task can widen its own permissions by editing its own
  instructions and Jarvis would obey on the next run. The row is outside the
  worktree and outside the task's reach.
- **A project need not have a repository.** Onboarding allows a project with no
  GitHub repo. A canonical file would mean such a project has no policy.

## Consequences

- Rendering is total or it fails: a placeholder that survives is refused rather
  than defaulted, since a rendering of nothing is not instructions. Enforced in
  `renderAgentsMd` and asserted by `scripts/s26-onboarding-test.ts`.
- The template exists twice — `AGENTS_TEMPLATE` in `src/agentsfile.ts`, which
  ships, and the fenced block in `docs/TEMPLATES.md`, which people read. The
  suite compares them byte for byte, because the production image copies `src`
  and not `docs`.
- Drift between the row and the committed file is expected and is not corruption.
  Detecting and reporting it is worth doing; silently trusting the file is not.
- If a future step wants the file to be authoritative for something, that is a
  new ADR, not an exception applied quietly at one call site.

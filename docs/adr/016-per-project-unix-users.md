# ADR 016 — Per-project unix users, via sudo + setpriv

- Status: accepted
- Date: 2026-09-02
- Plan sections: §12 (S12); completes ADR 006 step 5, which ADR 015 left unbuilt
- Affects isolation / billing / always-confirm: yes (isolation — this is the isolation)
- Decided by: Enrique, 2026-09-02

## Context

S12 shipped honestly and incomplete. A task in Alpha could read Beta's
`repo/.env` and Beta's browser profile: the runner saw the path in the harness's
Bash command, killed the run, discarded the branch, audited the attempted path
and raised an Issue — every time, and the test went red when the guard was
removed. But **the read itself succeeded**, because the runner and every
project's files were the same unix user. Detection worked; containment did not
exist, and S12 was marked `partial` for exactly that reason.

Three ways to close it were put to Enrique: run the runner as root and drop per
task; a small setuid helper of our own writing; or one container per project.

## Decision

**The runner stays `User=jarvis` and execs the harness through
`sudo setpriv --reuid --regid --clear-groups`.**

No setuid binary of our own. No root runner. No per-project container (which
would contradict ADR 015, whose whole point was to put the heavy runner on the
host).

- `/etc/sudoers.d/jarvis-runner` permits `jarvis` exactly one command shape:
  `/usr/bin/setpriv --reuid=jarvis-p-[a-z0-9-]* --regid=jarvis-p-[a-z0-9-]*
  --clear-groups -- <harness> *`. The binary is named absolutely, the targets can
  only be `jarvis-p-*`, and **root can never be named**.
- `NoNewPrivileges` comes off `jarvis-runner.service`. Sudo cannot elevate at all
  under it. This is the accepted cost of the decision, taken deliberately: the
  alternative is that every project keeps sharing one unix user.
- **Scope is ADR 006 step 5's**: professional and confidential (and restricted)
  projects get their own uid. Personal, normal projects keep sharing `jarvis` —
  a deliberate choice in ADR 006, not an oversight.
- Ownership: `/var/lib/jarvis/projects/<slug>` is
  `jarvis-p-<slug>:jarvis-p-<slug>` mode `2770`, with `jarvis` added to the
  project's group. The runner can prepare checkouts; the harness, running with
  `--clear-groups`, holds exactly one group — its own — so another project's
  directory is `0` to it.
- Users are provisioned by `deploy/provision-project-user.sh <slug>`, run as root
  on the host. A project whose user does not exist **parks** rather than falling
  back to the shared user. A silent fallback would be the quiet return of the
  hole this ADR closes.

## Consequences

- A cross-project read now fails `EACCES` in the kernel. The command scanner
  stays: defence in depth, and it still names the attempt in the audit trail.
- The runner can gain privilege through one sudoers rule. That rule is the
  smallest surface we could express: one binary, one flag set, a bounded set of
  target users, no root.
- `--clear-groups` is load-bearing rather than decorative. Without it the harness
  would inherit `jarvis`'s supplementary groups — which are exactly the group
  memberships that let the runner reach every project. `scripts/s12-privdrop-test.ts`
  proves this by negative control: with the groups kept the cross-project read
  succeeds; with them cleared it does not.
- Adding a professional project now has a manual step. It is one command, it is
  named in the Issue the runner raises, and the task waits rather than running
  unisolated.
- Group membership takes effect at service start, so provisioning a new project
  requires `systemctl restart jarvis-runner`.

## Verification

`scripts/s12-privdrop-test.sh` — 28 assertions, run as root against real unix
users, real directories and real `setpriv`:

- a project reads its own `.env` and gets the contents;
- the same process reading another project's `.env` gets
  `cat: …/repo/.env: Permission denied`, and none of the secret comes back;
- it cannot list or write into that directory either;
- with `--init-groups` instead of `--clear-groups` the read succeeds, which is
  what makes the flag's presence in the sudoers rule the thing being relied on;
- the runner itself still reaches both, or it could not prepare the work.

Enrique's instruction was to "assert the cross-project read now fails EACCES at
the filesystem layer, not merely that the tripwire fires". That is the assertion
above, and it goes nowhere near the tripwire.

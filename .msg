Four live faults: one owner, one boundary, and two criticals that were not

All four are the same kind of mistake — a guard or a directory that is right in
principle and wrong about ordinary work. A critical that fires on normal
behaviour gets ignored, which is how the real one gets missed.

1. **A project directory had two owners.** The API and worker create it as root
   inside containers; the heavy runner creates it as `jarvis` on the host. They
   share the volume, so whichever got there first decided — and
   `s22-call-mtk3zqpl` came out root:root 0700 beside jarvis-owned neighbours,
   after which the runner died with `EACCES: mkdir '.../<slug>/.ssh'`.
   `ensureProjectHome` now creates it 0750 and, when running as root, hands it
   to the jarvis uid. A directory owned by someone ELSE is left alone: ADR 016
   gives professional projects their own `jarvis-p-*` user and chowning that
   away would undo the isolation it exists for.

2. **`unscoped` is a real boundary.** A task with no project had nothing allowed
   but its cwd, so the ordinary business of a git worktree referencing its
   parent read as a cross-boundary access and raised a CRITICAL against
   `worktrees/unscoped`. It now gets its own directory under `unscoped` — and
   nothing else in it. The worktree parent is created 0750 rather than
   drwxr-xr-x under a drwxr-x--- parent.

3. **Two criticals that were not.** `/tmp/repro.mjs` — `PrivateTmp=true` means
   /tmp is the service's own namespace, and a harness writing a repro script
   there is doing exactly what it should. `/var/lib/jarvis`, the bare directory,
   reveals only the names of children that are each separately guarded. Both are
   permitted now; another project's checkout, another task's worktree, the keys
   and the harness-auth dir all still are not.

4. **A denial that worked is not a page.** Every enforced boundary was filed
   critical/open — the system doing its job, filling the queue. It is `medium`
   and `ui_only` now, still written down, still audited, and the title says
   nothing was granted.

Test — scripts/s12c-live-faults-test.sh, 21 assertions, 0 failed. The
allowed-path computation is exported and asserted directly, because the fault was
in the WIRING: a test that supplies its own list can only prove what the checker
does with a list, never that the runner hands it the right one.

Seen red first: one sabotage run reverting the tmp rule, the ownership and the
severity turned 6 red; a second reverting the unscoped boundary turned the
wiring assertion red.

s12-isolation (47), s12-privdrop (36) and s6-workflow (33) all still pass.

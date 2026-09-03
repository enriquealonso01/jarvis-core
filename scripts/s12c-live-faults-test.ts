/**
 * Four live faults, from the box, 2026-09-02.
 *
 * Every one of them is the same kind of mistake: a guard or a directory that is
 * right in principle and wrong about ordinary work. A project directory whose
 * owner depended on which process got there first; a task with no project whose
 * own worktree was outside its own boundary; a scratch file in a PRIVATE /tmp
 * filed as an isolation breach; and a denial that worked, filed as critical.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPool } from "../src/db.js";
import { allowedPathsFor, escapedPath } from "../src/runner.js";
import { ensureProjectHome } from "../src/checkout.js";
import { PROJECTS_DIR, WORKTREES_DIR } from "../src/paths.js";

const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 200)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));

const STAMP = Date.now().toString(36).slice(-5);

/** A tool_use event, the shape the harness streams. */
const touching = (input: Record<string, unknown>) => ({
  message: { content: [{ type: "tool_use", input }] },
});

async function main(): Promise<void> {
  console.log("########## one owner for a project directory ##########\n");
  {
    const slug = `ownercheck-${STAMP}`;
    const dir = path.join(PROJECTS_DIR, slug);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);

    const made = await ensureProjectHome(slug);
    check("it is where the project lives", dir, made);
    const st = await fs.stat(dir);
    check("created 0750, like its parent", 0o750, st.mode & 0o777);

    if (process.getuid?.() === 0) {
      const uid = Number(process.env.JARVIS_UID ?? 1000);
      check("and handed to the jarvis uid rather than left as root", uid, st.uid);

      // A directory that already belongs to someone else is left alone: ADR 016
      // gives professional projects their own user, and taking that away would
      // undo the isolation it exists for.
      await fs.chown(dir, 4242, 4242);
      await ensureProjectHome(slug);
      const again = await fs.stat(dir);
      check("a directory owned by someone else is not taken over", 4242, again.uid);
      await fs.chown(dir, 0, 0);
      await ensureProjectHome(slug);
      check("but a root-owned one is", uid, (await fs.stat(dir)).uid);
    } else {
      ok("(not root here, so there is nothing to hand over)");
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log("\n########## a private /tmp is not outside ##########\n");
  {
    const cwd = path.join(WORKTREES_DIR, "someproject", "abcd1234");
    check(
      "a scratch file in /tmp is ordinary work, not a breach",
      null,
      escapedPath(cwd, touching({ file_path: "/tmp/repro.mjs" }), []),
    );
    check(
      "and so is one in the system temp dir",
      null,
      escapedPath(cwd, touching({ file_path: path.join(os.tmpdir(), "probe.txt") }), []),
    );
    truthy(
      "while another project's checkout still is a breach",
      escapedPath(cwd, touching({ file_path: path.join(PROJECTS_DIR, "beta", "repo", ".env") }), []),
    );
    truthy(
      "and so are the keys",
      escapedPath(cwd, touching({ command: "cat /var/lib/jarvis/keys/master.key" }), []),
    );
    check(
      "the root directory itself is not a breach — it reveals only names",
      null,
      escapedPath(cwd, touching({ file_path: "/var/lib/jarvis" }), []),
    );
    check(
      "a task touching its OWN project's repo is not a breach",
      null,
      escapedPath(
        path.join(WORKTREES_DIR, "n1-console", "53eb8bdd"),
        touching({ file_path: path.join(PROJECTS_DIR, "n1-console", "repo", "src", "x.ts") }),
        allowedPathsFor("n1-console", "53eb8bdd-0000-0000-0000-000000000000"),
      ),
    );
  }

  console.log("\n########## unscoped is a real boundary ##########\n");
  {
    // The list the RUNNER actually passes, not one invented here: the fault was
    // in the wiring, and a test that supplies its own list cannot see it.
    const taskId = "50bbfb35-6b4a-4603-b2f8-c1025736e90b";
    const own = path.join(WORKTREES_DIR, "unscoped", taskId.slice(0, 8));
    /*
     * The run may read its OWN harness auth directory, and nothing else under
     * harness-auth. The runner hands the vendor CLI that path, so reading it is
     * expected; the parent holds every other profile's tokens, so reading THAT
     * is the escape this whole tripwire exists for. A live run was killed for
     * the former after 22 tool calls of real work, which is what sent this
     * looking.
     */
    {
      const mine = "/var/lib/jarvis/harness-auth/anthropic_personal";
      const scoped = allowedPathsFor("n1-console", taskId, mine);
      truthy("its own auth dir is allowed", scoped.includes(mine));
      truthy("but not the directory holding every profile",
        !scoped.includes("/var/lib/jarvis/harness-auth"));
      const other = escapedPath("/var/lib/jarvis/worktrees/n1-console/aaaaaaaa",
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash",
          input: { command: "cat /var/lib/jarvis/harness-auth/openai_codex_personal/auth.json" } }] } },
        scoped);
      truthy("and another profile's tokens are still an escape", Boolean(other));

      /*
       * The shared known_hosts is allowed, and must stay a known_hosts.
       *
       * git push reads it and a run was killed for that, having already pushed
       * its branch successfully. Allowing the directory is only safe while it
       * holds nothing but public host fingerprints, so that is asserted rather
       * than assumed: the day a private key appears there, this fails.
       */
      const sshHome = "/var/lib/jarvis/home/.ssh";
      truthy("the shared known_hosts directory is allowed", scoped.includes(sshHome));
      const fs2 = await import("node:fs/promises");
      const entries = await fs2.readdir(sshHome).catch(() => [] as string[]);
      if (entries.length) {
        const keys = entries.filter((f) => f !== "known_hosts");
        keys.length === 0
          ? ok("and it holds nothing but known_hosts")
          : bad("the ssh home holds only known_hosts", "known_hosts only", keys.join(", "));
      } else {
        // Said out loud rather than skipped in silence: this container has no
        // such directory, so the check above proved nothing here. It is the box
        // that has to satisfy it, and a silent skip is how that gets forgotten.
        console.log("  SKIP  no ssh home in this container; the key-material check did not run");
      }
    }

    const allowed = allowedPathsFor(null, taskId);
    check("a task with no project is given its own unscoped directory", own, allowed[0]);
    check("and one WITH a project is given the project",
      path.join(PROJECTS_DIR, "alpha"), allowedPathsFor("alpha", taskId)[0]);
    check(
      "a task with no project may touch its own worktree",
      null,
      escapedPath(own, touching({ file_path: path.join(own, "notes.md") }), allowed),
    );
    check(
      "and the git plumbing that references it",
      null,
      escapedPath(own, touching({ command: `git -C ${own} status` }), allowed),
    );
    truthy(
      "but not another unscoped task's worktree",
      escapedPath(own, touching({ command: `cat ${path.join(WORKTREES_DIR, "unscoped", "deadbeef", "x")}` }), allowed),
    );
    truthy(
      "nor a project's",
      escapedPath(own, touching({ command: `cat ${path.join(WORKTREES_DIR, "alpha", "aaaa1111", "x")}` }), allowed),
    );
  }

  console.log("\n########## the path guard covers the whole root ##########\n");
  {
    /*
     * II.5 enumerates seven places a task may not touch. The guard listed five:
     * `openclaw/` — the paired WhatsApp session — and another project's
     * `artifacts/` were both missing, which is the plan's own warning about
     * prose reading as complete. The rule is inverted now: anything under
     * /var/lib/jarvis that is not positively permitted is a breach, so the
     * eighth directory is protected the day it is created.
     */
    const cwd = path.join(WORKTREES_DIR, "alpha", "aaaa1111");
    const allowed = allowedPathsFor("alpha", "aaaa1111-0000-0000-0000-000000000000");
    const root = process.env.JARVIS_ROOT ?? "/var/lib/jarvis";
    const breach = (p: string) => escapedPath(cwd, touching({ command: `cat ${p}` }), allowed);

    const mustDeny: [string, string][] = [
      ["another project's checkout", path.join(root, "projects", "beta", "repo", ".env")],
      ["another task's worktree", path.join(root, "worktrees", "alpha", "bbbb2222", "x")],
      ["another project's worktree", path.join(root, "worktrees", "beta", "cccc3333", "x")],
      ["a browser profile", path.join(root, "browsers", "beta", "Cookies")],
      ["the harness logins", path.join(root, "harness-auth", "anthropic_personal", "creds.json")],
      ["the master key", path.join(root, "keys", "master.key")],
      ["the paired WhatsApp session", path.join(root, "openclaw", "session", "creds.json")],
      ["another project's artifacts", path.join(root, "artifacts", "beta", "transcript.jsonl")],
      ["a directory nobody has thought of yet", path.join(root, "something-new", "secret")],
    ];
    for (const [what, p] of mustDeny) {
      truthy(`${what} is a breach`, breach(p));
    }

    const mustAllow: [string, string][] = [
      ["its own worktree", path.join(cwd, "src", "index.ts")],
      ["its own project's checkout", path.join(root, "projects", "alpha", "repo", "src", "x.ts")],
      ["its own artifacts", path.join(root, "artifacts", "alpha", "transcript.jsonl")],
      ["a system path outside the root", "/usr/lib/node_modules/npm/package.json"],
      ["the scratch directory", "/tmp/repro.mjs"],
    ];
    for (const [what, p] of mustAllow) {
      check(`${what} is not`, null, breach(p));
    }
  }

  console.log("\n########## a denial that worked is not a page ##########\n");
  {
    const { recordDenial } = await import("../src/isolation.js");
    await pool.query("DELETE FROM issues WHERE dedupe_key LIKE 'sec.isolation:%probe-%'");
    await recordDenial(pool, {
      denial: { allowed: false, code: "security.isolation", reason: "not allowlisted" },
      capability: `probe-${STAMP}`,
      projectId: null,
    });
    const issue = await pool.query<{ severity: string; status: string; title: string }>(
      `SELECT severity, status, title FROM issues WHERE dedupe_key = $1`,
      [`sec.isolation:system:probe-${STAMP}`],
    );
    truthy("the denial is still written down", issue.rowCount === 1);
    check("but as medium, not critical", "medium", issue.rows[0]?.severity);
    truthy("and it says nothing was granted", issue.rows[0]?.title.includes("nothing was granted"));

    const audit = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
       WHERE actor = 'broker' AND target = $1`,
      [`probe-${STAMP}`],
    );
    check("with the audit row, which is what actually matters", "1", audit.rows[0].n);
    await pool.query("DELETE FROM issues WHERE dedupe_key = $1", [`sec.isolation:system:probe-${STAMP}`]);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

/**
 * S12's wall: the cross-project read now FAILS, rather than being caught.
 *
 * S12 shipped with a hole it named honestly. A task in Alpha could read Beta's
 * `.env`: the runner saw the path in the harness's Bash command, killed the run,
 * discarded the branch and raised an issue — every time — but the read itself
 * succeeded, because the runner and every project's files were the same unix
 * user. Detection worked; containment did not exist.
 *
 * Enrique's decision (ADR 016): the runner stays `User=jarvis` and execs the
 * harness through `sudo setpriv --reuid/--regid --clear-groups`, permitted by
 * one sudoers rule that can never name root. And the verification he asked for,
 * in his words: "assert the cross-project read now fails EACCES at the
 * filesystem layer, not merely that the tripwire fires."
 *
 * So this test does not go near the tripwire. It builds the real ownership model
 * with real unix users, and then tries the read.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { asProjectUser, needsOwnUser, projectUnixUser } from "../src/unixuser.js";

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
const contains = (m: string, n: string, h: string) =>
  h.includes(n) ? ok(m) : bad(m, `contains ${n}`, h);

const STAMP = Date.now().toString(36).slice(-4);
const ROOT = process.env.JARVIS_ROOT ?? "/var/lib/jarvis";
const ALPHA = `alpha${STAMP}`;
const BETA = `beta${STAMP}`;

/** Run something and report how it went, without throwing. */
async function attempt(
  command: string,
  args: string[],
): Promise<{ ok: boolean; out: string; err: string; code: number | null }> {
  try {
    const r = await run(command, args, { timeout: 20_000 });
    return { ok: true, out: r.stdout, err: r.stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      ok: false,
      out: err.stdout ?? "",
      err: (err.stderr ?? err.message ?? "").trim(),
      code: typeof err.code === "number" ? err.code : null,
    };
  }
}

/** Exactly what deploy/provision-project-user.sh does, so the test proves that model. */
async function provision(slug: string): Promise<string> {
  const user = projectUnixUser(slug);
  await attempt("useradd", ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", user]);
  const dir = path.join(ROOT, "projects", slug);
  await fs.mkdir(path.join(dir, "repo"), { recursive: true });
  await fs.writeFile(path.join(dir, "repo", ".env"), `SECRET_OF_${slug.toUpperCase()}=hunter2\n`);
  await run("chown", ["-R", `${user}:${user}`, dir]);
  await run("chmod", ["-R", "g+rwX,o-rwx", dir]);
  await run("chmod", ["2770", dir]);
  return user;
}

async function main(): Promise<void> {
  console.log("########## the naming, and who gets a user at all ##########\n");
  {
    check("a project's user is derived from its slug", "jarvis-p-alpha-web", projectUnixUser("alpha-web"));
    const long = projectUnixUser("a-very-long-professional-project-slug-indeed");
    truthy(`a long slug still fits a unix username (${long})`, long.length <= 32);
    check(
      "and two slugs sharing a prefix do not share a user",
      false,
      projectUnixUser("a-very-long-professional-project-slug-indeed")
        === projectUnixUser("a-very-long-professional-project-slug-other"),
    );

    check("a professional project gets its own user",
      true, needsOwnUser({ projectType: "professional", confidentiality: "normal" }));
    check("so does a confidential one",
      true, needsOwnUser({ projectType: "personal", confidentiality: "confidential" }));
    check("and a restricted one",
      true, needsOwnUser({ projectType: "personal", confidentiality: "restricted" }));
    check("a personal, normal project keeps sharing jarvis, per ADR 006 step 5",
      false, needsOwnUser({ projectType: "personal", confidentiality: "normal" }));
  }

  console.log("\n########## the drop command is the one the sudoers rule permits ##########\n");
  {
    const wrapped = asProjectUser("jarvis-p-alpha-web", "/usr/local/bin/claude", ["-p", "do the thing"]);
    check("it goes through sudo", "sudo", wrapped.command);
    contains("non-interactively", "-n", wrapped.args.join(" "));
    contains("via setpriv, named absolutely", "/usr/bin/setpriv", wrapped.args.join(" "));
    contains("dropping the uid", "--reuid=jarvis-p-alpha-web", wrapped.args.join(" "));
    contains("and the gid", "--regid=jarvis-p-alpha-web", wrapped.args.join(" "));
    contains(
      "and clearing the supplementary groups, which is what removes the runner's reach",
      "--clear-groups",
      wrapped.args.join(" "),
    );
    check(
      "the harness is separated from setpriv's own arguments",
      "--",
      wrapped.args[wrapped.args.indexOf("--clear-groups") + 1],
    );
    truthy("and it never names root", !wrapped.args.join(" ").includes("root"));
  }

  console.log("\n########## the wall itself ##########\n");
  if (process.getuid?.() !== 0) {
    bad("this test needs root to create users", "uid 0", process.getuid?.());
  } else {
    const alphaUser = await provision(ALPHA);
    const betaUser = await provision(BETA);
    ok(`provisioned ${alphaUser} and ${betaUser}`);

    const alphaEnv = path.join(ROOT, "projects", ALPHA, "repo", ".env");
    const betaEnv = path.join(ROOT, "projects", BETA, "repo", ".env");

    // 1. Its own file: readable. Isolation that also breaks the work is not
    //    isolation, it is an outage.
    const own = await attempt("setpriv",
      [`--reuid=${alphaUser}`, `--regid=${alphaUser}`, "--clear-groups", "--", "cat", alphaEnv]);
    check("a project can read its OWN files", true, own.ok);
    contains("and gets the real contents", `SECRET_OF_${ALPHA.toUpperCase()}`, own.out);

    // 2. The other project's file: EACCES. This is the assertion the whole step
    //    turned on, and until today it read the secret out loud.
    const cross = await attempt("setpriv",
      [`--reuid=${alphaUser}`, `--regid=${alphaUser}`, "--clear-groups", "--", "cat", betaEnv]);
    check("a project canNOT read another project's files", false, cross.ok);
    contains("and the kernel is what refuses, not a tripwire", "Permission denied", cross.err);
    check("nothing of the secret came back", false, cross.out.includes("hunter2"));
    console.log(`        ${cross.err.split("\n")[0]}`);

    // 3. Not even the directory listing.
    const list = await attempt("setpriv",
      [`--reuid=${alphaUser}`, `--regid=${alphaUser}`, "--clear-groups", "--", "ls", path.join(ROOT, "projects", BETA)]);
    check("nor list the directory", false, list.ok);
    contains("also refused by the kernel", "Permission denied", list.err);

    // 4. And it cannot write there either.
    const write = await attempt("setpriv",
      [`--reuid=${alphaUser}`, `--regid=${alphaUser}`, "--clear-groups", "--",
        "sh", "-c", `echo x > ${path.join(ROOT, "projects", BETA, "repo", "planted")}`]);
    check("nor write into it", false, write.ok);

    /*
     * 5. The load-bearing flag, proved rather than trusted.
     *
     * Without --clear-groups the harness keeps the runner's supplementary
     * groups. Here that is demonstrated directly: put alpha's user in beta's
     * group, and the read that just failed succeeds — which is exactly what
     * would happen in production if the flag were dropped from the sudoers rule.
     */
    await run("usermod", ["-aG", betaUser, alphaUser]);
    const withGroups = await attempt("setpriv",
      [`--reuid=${alphaUser}`, `--regid=${alphaUser}`, "--init-groups", "--", "cat", betaEnv]);
    check("with the groups kept, the same read succeeds", true, withGroups.ok);
    const cleared = await attempt("setpriv",
      [`--reuid=${alphaUser}`, `--regid=${alphaUser}`, "--clear-groups", "--", "cat", betaEnv]);
    check("and with --clear-groups it does not", false, cleared.ok);
    ok("...so the flag is load-bearing, and the sudoers rule requires it");

    // 6. The runner itself keeps its reach, or it could not prepare the work.
    const asRunner = await attempt("cat", [betaEnv]);
    check("the runner can still read both, which is how it prepares checkouts", true, asRunner.ok);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    // Leave nothing behind: these users and directories are the test's own.
    for (const slug of [ALPHA, BETA]) {
      await attempt("userdel", [projectUnixUser(slug)]);
      await fs.rm(path.join(ROOT, "projects", slug), { recursive: true, force: true }).catch(() => undefined);
    }
    console.log(`\n==== ${pass} passed, ${fail} failed ====`);
    process.exit(fail === 0 ? 0 : 1);
  });

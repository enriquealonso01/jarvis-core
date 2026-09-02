import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";

const run = promisify(execFile);

/**
 * Per-project unix users — the wall behind the file tripwire (ADR 006 step 5,
 * decided in ADR 016).
 *
 * S12 proved that a task in Alpha could read Beta's `.env`: the runner detected
 * it, killed the run and raised an issue, every time — but the read itself
 * SUCCEEDED, because the runner and every project's files were the same unix
 * user. Detection worked; containment did not exist.
 *
 * The decision: the runner stays `User=jarvis` and execs the harness through
 * `sudo setpriv --reuid --regid --clear-groups`, which is permitted by a sudoers
 * rule that names only that command and only `jarvis-p-*` targets. Never root,
 * and no setuid binary of our own writing.
 *
 * Scope is ADR 006's: professional and confidential projects get their own uid.
 * Personal projects keep sharing `jarvis`, which is a deliberate choice in that
 * ADR rather than an oversight.
 */

/** Maximum length of a unix username on Linux (`useradd` rejects longer). */
const MAX_NAME = 32;

/**
 * The unix user for a project.
 *
 * Slugs are longer than usernames may be, so a long one is truncated and given
 * a short hash of the full slug — two projects whose slugs share a prefix must
 * never share a user, which is the entire point of this file.
 */
export function projectUnixUser(slug: string): string {
  const safe = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  const full = `jarvis-p-${safe}`;
  if (full.length <= MAX_NAME) return full;
  const digest = crypto.createHash("sha256").update(slug).digest("hex").slice(0, 6);
  return `${full.slice(0, MAX_NAME - 7)}-${digest}`;
}

/**
 * Does this project get its own unix user?
 *
 * ADR 006 step 5: "professional or confidential projects" get a dedicated uid at
 * project create. A restricted project is confidential and then some.
 */
export function needsOwnUser(args: {
  projectType?: string | null;
  confidentiality?: string | null;
}): boolean {
  const type = (args.projectType ?? "").toLowerCase();
  const conf = (args.confidentiality ?? "").toLowerCase();
  return type === "professional" || conf === "confidential" || conf === "restricted";
}

/** Does the user exist on this host? */
export async function unixUserExists(name: string): Promise<boolean> {
  try {
    await run("id", ["-u", name]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrap a command so it runs as the project's user.
 *
 * `sudo` elevates for exactly as long as it takes `setpriv` to drop, and the
 * sudoers rule permits nothing else. `--clear-groups` is what stops the harness
 * inheriting `jarvis`'s supplementary groups — including the group memberships
 * that let the RUNNER reach every project's directory. Without it the drop would
 * change the uid and change nothing about what could be read.
 */
export function asProjectUser(
  user: string,
  command: string,
  args: string[],
): { command: string; args: string[] } {
  return {
    command: "sudo",
    args: [
      "-n",
      "/usr/bin/setpriv",
      `--reuid=${user}`,
      `--regid=${user}`,
      "--clear-groups",
      "--",
      command,
      ...args,
    ],
  };
}

/** The exact command an operator has to run to provision a project's user. */
export function provisionCommand(slug: string): string {
  return `sudo /opt/jarvis/core/deploy/provision-project-user.sh ${slug}`;
}

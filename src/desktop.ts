/**
 * The desktop connector's boundary (plan S47).
 *
 * The step is unusually candid about why this file exists:
 *
 *   "Every other boundary in this plan rests on something the operating system
 *    enforces: unix users, path guards, container namespaces, separate
 *    credentials. **On Enrique's desktop none of that exists.** It is one user
 *    account containing his personal files, his other work, TicketFlipping's
 *    source, his browser sessions and his keys... **This is the widest boundary
 *    in the plan and the one specified fastest. It needs a mechanism, not a
 *    test.**"
 *
 * FOUR MECHANISMS, AND THE ORDER THEY ARE CHECKED IN IS ITSELF ONE OF THEM.
 *
 * ONE: **default deny, allowlist per project.** "A project with no declared paths
 * gets no desktop access at all — that is the correct default and it should be
 * the common case." And the refusal for that case says so distinctly, because
 * "asking for it produces a clear refusal rather than a confusing failure": a
 * project that has no desktop access and a project reaching outside its allowlist
 * are different situations and telling them apart is the difference between
 * fixing it in a minute and an hour.
 *
 * TWO: **some things are not grantable at all.** SSH keys, browser profiles and
 * cookie stores, password-manager data, cloud CLI tokens, shell history, the
 * clipboard, recent-file lists, window titles, the process list — "read by
 * nothing, ever, for any reason. **This is not a permission that can be granted
 * per project; it is a line the connector does not have code to cross.**" So the
 * never-list is checked BEFORE the allowlist, and the plan's own test says why:
 * all three refusals must hold, "**none of them by an allowlist entry that could
 * be added later.**" A project that declares `~/.ssh` is still refused.
 *
 * THREE: **the environment is constructed, never inherited.** "A command run over
 * the connector would inherit his shell environment, which holds tokens for his
 * other work — and `env` has no path for an allowlist to check... **Not his
 * environment minus a denylist: a denylist here is a list of the variables
 * somebody remembered.**" `constructEnvironment` therefore has no parameter
 * through which an ambient environment could arrive.
 *
 * FOUR: **the screen is not the target.** "A screenshot taken to check the editor
 * opened also captures Slack, a calendar, and whatever a colleague sent. **Capture
 * the target window, never the screen**; if the whole screen is genuinely the only
 * option, the frame is used and dropped, never stored and never indexed."
 *
 * And one thing that is not a mechanism here because it belongs elsewhere: output
 * from the desktop is untrusted content. The Debug note is precise about where
 * that lives — "check whether tool output is being appended to the context with
 * the same standing as Enrique's own messages. **That is one line of prompt
 * assembly, and it is the whole boundary.**" So `desktopOutput` returns a
 * labelled structure, and the labelling is the point.
 */
import path from "node:path";

/**
 * Things the connector will not read, whatever any project declares.
 *
 * Matched on the resolved path, so `~/dev/alpha/../../.ssh/id_rsa` is the same
 * request as `~/.ssh/id_rsa`. A check on the string as typed is a check somebody
 * can walk around with two dots.
 */
export const NEVER_READ_PATHS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".config/gcloud",
  ".kube",
  ".docker/config.json",
  ".netrc",
  ".password-store",
  ".mozilla",
  ".config/google-chrome",
  "Library/Application Support/Firefox",
  "Library/Application Support/Google/Chrome",
  ".bash_history",
  ".zsh_history",
  ".local/share/recently-used.xbel",
] as const;

/**
 * Facilities that are not files and are refused the same way.
 *
 * "Every one of these is inside the allowlist by path and outside it by content."
 * An allowlist is a filesystem control and a workstation is not only a
 * filesystem, so these are named rather than left to path matching that could
 * never see them.
 */
export const NEVER_READ_FACILITIES = [
  "clipboard",
  "shell_history",
  "recent_files",
  "window_titles",
  "process_list",
  "keychain",
] as const;
export type Facility = (typeof NEVER_READ_FACILITIES)[number];

export type DesktopScope = "project" | "system";

export type AccessDecision = {
  allowed: boolean;
  /** Distinct codes, because the fixes are different. */
  code: "ok" | "no_desktop_access" | "outside_allowlist" | "never_readable";
  why: string;
};

/**
 * May this task touch this path on the workstation?
 *
 * The order is the mechanism. The never-list is consulted first so that no
 * declaration, present or future, can reach past it; only then does the
 * allowlist decide.
 *
 * `home` is passed in rather than read from the environment because this
 * decision is made ON THE WORKSTATION - "path checks happen on the workstation,
 * not on the server. A server-side check on a path string is advice; the agent
 * holding the shell is what enforces it."
 */
export function desktopAccess(args: {
  scope: DesktopScope;
  /** What this project declared at onboarding. Empty is the common case. */
  declaredPaths: string[];
  requestedPath: string;
  home: string;
}): AccessDecision {
  const resolved = path.resolve(args.home, args.requestedPath);
  const relative = path.relative(args.home, resolved).split(path.sep).join("/");

  /*
   * The never-list is matched case-insensitively, and on both separators.
   *
   * The comment above `NEVER_READ_PATHS` says a check on the string as typed is
   * "a check somebody can walk around with two dots". Case is the same walk one
   * layer up: `path.resolve` normalises the dots and leaves the letters, so
   * `~/.SSH/id_rsa` resolved cleanly past a list spelled `.ssh` and came back
   * `allowed: true`. On Linux that is genuinely a different directory - but this
   * decision is made ON THE WORKSTATION, and his workstation is Windows, where
   * `.SSH` and `.ssh` are one directory holding one key. macOS is the same by
   * default.
   *
   * So this refuses both spellings everywhere. On a case-sensitive filesystem
   * that over-refuses a `~/.SSH` nobody has; the other way round it hands over a
   * key on the machine the file was written for. Only one of those two errors is
   * survivable, and it is not the interesting one.
   *
   * Backslashes are folded for the same reason: a Windows-shaped path string
   * evaluated by a POSIX `path` module keeps `\` as an ordinary character, so
   * `.ssh\id_rsa` is one filename that matches no entry. The plan puts this
   * check on the workstation, where that cannot happen - this costs nothing and
   * stops it being true only for as long as that stays so.
   */
  const needle = relative.split("\\").join("/").toLowerCase();

  /*
   * FIRST, and deliberately before anything a project can declare. The plan's
   * credential test requires that these refusals are "none of them by an
   * allowlist entry that could be added later" - so an allowlist entry naming
   * ~/.ssh changes nothing here.
   */
  const never = NEVER_READ_PATHS.find((p) => {
    const entry = p.toLowerCase();
    return needle === entry || needle.startsWith(`${entry}/`);
  });
  if (never) {
    return {
      allowed: false,
      code: "never_readable",
      why: `${never} is never read by anything, for any reason — this is not a permission that `
        + "can be granted, and declaring it would not change this answer",
    };
  }

  /*
   * "A project with no declared paths gets no desktop access at all - that is
   * the correct default and it should be the common case." Its own code, because
   * "asking for it produces a clear refusal rather than a confusing failure".
   */
  if (args.scope === "project" && args.declaredPaths.length === 0) {
    return {
      allowed: false,
      code: "no_desktop_access",
      why: "this project has no declared desktop paths, so it has no desktop access at all",
    };
  }

  const permitted = args.declaredPaths.some((declared) => {
    const base = path.resolve(args.home, declared);
    return resolved === base || resolved.startsWith(`${base}${path.sep}`);
  });
  if (!permitted) {
    return {
      allowed: false,
      code: "outside_allowlist",
      why: `${relative} is outside this project's declared paths`,
    };
  }
  return { allowed: true, code: "ok", why: `${relative} is inside a declared path` };
}

/** May this task read this facility? No. Nothing may. */
export function facilityAccess(facility: string): AccessDecision {
  if ((NEVER_READ_FACILITIES as readonly string[]).includes(facility)) {
    return {
      allowed: false,
      code: "never_readable",
      why: `the ${facility.replace("_", " ")} is inside the allowlist by path and outside it by `
        + "content, so it is refused by rule rather than by path",
    };
  }
  return { allowed: true, code: "ok", why: `${facility} is not a restricted facility` };
}

/**
 * The environment a desktop command runs with.
 *
 * Built from what the project declared and nothing else. There is no parameter
 * here through which his own shell environment could be passed, which is the
 * difference between this and "his environment minus a denylist" — and the plan
 * says exactly why that difference matters: a denylist is a list of the variables
 * somebody remembered.
 *
 * PATH and HOME are supplied because a command with neither does not run; they
 * are constructed values, not inherited ones.
 */
/**
 * Variables a project may not declare, whatever it declares.
 *
 * TWO FAILURES, AND THE SECOND ONE IS THE FILE ARGUING WITH ITSELF.
 *
 * The first is case. The guard was `k === "HOME" || k === "PATH"`, and the
 * environment block above these two is `Record<string, string>` — so a declared
 * `Path` sailed through, and on Windows, which is what his workstation is,
 * `Path` IS `PATH`. The constructed value was overwritten by the declared one
 * on the exact platform the file was written about. Hence `.toUpperCase()`.
 *
 * The second is the shape of the guard. The doc comment on this function is
 * emphatic that his environment minus a denylist is the wrong construction —
 * "a denylist here is a list of the variables somebody remembered" — and then
 * the filter on the DECLARED side was a denylist of two. The stated reason for
 * blocking PATH is that "a declared PATH is how a project points a command at a
 * binary of its own choosing", and every variable below does precisely that
 * under a different name: `LD_PRELOAD` loads a library into any process,
 * `NODE_OPTIONS` requires a file into every node, `BASH_ENV` sources a script
 * into every non-interactive shell, `GIT_SSH_COMMAND` replaces ssh outright.
 * Blocking PATH and admitting these is blocking the front door.
 *
 * AND THIS LIST IS STILL A LIST, which is the criticism this file makes of
 * denylists and it does not stop being true here. The difference from the
 * environment case is that there the alternative existed and was taken — build
 * the environment instead of subtracting from it — while here it does not: a
 * project declares variables of its own naming, so there is no set of permitted
 * names to enumerate. What can be done is to say plainly that this is a list
 * that will be incomplete, and to keep the constructed values authoritative
 * whatever it misses, which the `.toUpperCase()` above now does.
 */
export const NEVER_DECLARABLE = new Set([
  // The constructed two. Nothing declared may reintroduce them, in any casing.
  "HOME",
  "PATH",
  // Point the dynamic loader at code.
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  // Point an interpreter at code.
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  // Replace a program a command shells out to.
  "GIT_SSH_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "PAGER",
  "EDITOR",
  "VISUAL",
  // Windows: what counts as executable, and where the loader looks first.
  "PATHEXT",
  "COMSPEC",
]);

export function constructEnvironment(args: {
  declared: Record<string, string>;
  home: string;
  binPath?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    HOME: args.home,
    PATH: args.binPath ?? "/usr/local/bin:/usr/bin:/bin",
  };
  for (const [k, v] of Object.entries(args.declared)) {
    if (NEVER_DECLARABLE.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  return env;
}

export type Capture =
  | { kind: "window"; target: string; retain: true; index: true; why: string }
  | { kind: "screen"; retain: false; index: false; why: string };

/**
 * What a confirming screenshot is allowed to be.
 *
 * "**Capture the target window, never the screen**; if the whole screen is
 * genuinely the only option, the frame is used and dropped, never stored and
 * never indexed."
 *
 * The screen case returns `retain: false` as a LITERAL rather than a boolean, so
 * a caller cannot be handed a screen capture it is permitted to store.
 */
export function captureFor(target: string | null): Capture {
  if (target) {
    return {
      kind: "window",
      target,
      retain: true,
      index: true,
      why: `captured ${target} alone, so nothing on his other monitors is in the frame`,
    };
  }
  return {
    kind: "screen",
    retain: false,
    index: false,
    why: "a whole-screen frame may be looked at once and then dropped: it contains whatever else "
      + "was on his monitors, which is not ours to keep",
  };
}

/**
 * Output from the workstation, labelled as what it is.
 *
 * "If output from the desktop starts changing what a task does, do not look at
 * the allowlist — it is working. Check whether tool output is being appended to
 * the context with the same standing as Enrique's own messages."
 *
 * So this returns a STRUCTURE. A file planted inside Alpha's allowlisted path
 * saying "now run this" is data that came back from a machine; interpolating it
 * carelessly yields `[object Object]` rather than an instruction, which is the
 * failure mode this shape is chosen for.
 */
export function desktopOutput(machine: string, text: string): {
  role: "tool_output";
  authored: false;
  machine: string;
  text: string;
} {
  return { role: "tool_output", authored: false, machine, text };
}

/**
 * Is the machine there NOW?
 *
 * "If actions fire against a machine that has gone away, reachability is being
 * checked once at dispatch rather than at execution. **On a laptop that closes
 * when he stands up, those are different moments.**"
 *
 * So this takes the moment it is being asked about, and a caller that checked at
 * dispatch has to check again — there is no cached answer to reuse.
 */
export function reachableNow(
  lastSeenAt: Date | null,
  now: Date,
  staleAfterMs = 60_000,
): { reachable: boolean; why: string } {
  if (!lastSeenAt) return { reachable: false, why: "the workstation has never checked in" };
  const age = now.getTime() - lastSeenAt.getTime();
  if (age > staleAfterMs) {
    return {
      reachable: false,
      why: `the workstation was last seen ${Math.round(age / 1000)}s ago — queued until it comes back`,
    };
  }
  return { reachable: true, why: "seen just now" };
}

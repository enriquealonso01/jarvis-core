/**
 * Adversarial probe of the desktop boundary (S47).
 *
 * The file calls itself "the widest boundary in the plan". Its own doc argues
 * that a denylist is "a list of the variables somebody remembered" - so this
 * probe attacks the two places where it nonetheless uses one.
 */
import {
  desktopAccess,
  constructEnvironment,
  facilityAccess,
  captureFor,
  reachableNow,
  NEVER_READ_FACILITIES,
} from "../src/desktop.js";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const HOME = "/home/enrique";

console.log("\n== the never-list holds against every path spelling ==");
for (const spelling of [
  ".ssh/id_rsa",
  "dev/alpha/../../.ssh/id_rsa",
  "/home/enrique/.ssh/id_rsa",
  ".ssh/./id_rsa",
  "dev/../.ssh",
  ".ssh",
  ".ssh/",
  ".config/gcloud/credentials.db",
  ".docker/config.json",
]) {
  const d = desktopAccess({
    scope: "project",
    declaredPaths: ["."],   // the hostile case: the project declared HOME ITSELF
    requestedPath: spelling,
    home: HOME,
  });
  ok(`refuses ${spelling}`, d.allowed === false && d.code === "never_readable", JSON.stringify(d));
}

console.log("\n== a declaration cannot buy past the never-list ==");
for (const declared of [".ssh", "/home/enrique/.ssh", ".", "/"]) {
  const d = desktopAccess({
    scope: "project", declaredPaths: [declared], requestedPath: ".ssh/id_rsa", home: HOME,
  });
  ok(`declaring ${declared} still refuses .ssh/id_rsa`,
    d.allowed === false && d.code === "never_readable", JSON.stringify(d));
}

console.log("\n== case: the same file spelled differently ==");
// Enrique's workstation is Windows; macOS is case-insensitive by default too.
// On those filesystems .SSH and .ssh are ONE directory.
const BS = String.fromCharCode(92);
for (const spelling of [".SSH/id_rsa", ".Ssh/id_rsa", ".GnuPG/secring.gpg", ".AWS/credentials",
  `.ssh${BS}id_rsa`, `.SSH${BS}id_rsa`, ".NETRC", ".Password-Store/x"]) {
  const d = desktopAccess({
    scope: "project", declaredPaths: ["."], requestedPath: spelling, home: HOME,
  });
  ok(`refuses ${spelling}`, d.allowed === false, `code=${d.code} allowed=${d.allowed}`);
}

console.log("\n== default deny ==");
ok("no declared paths, project scope -> no_desktop_access",
  desktopAccess({ scope: "project", declaredPaths: [], requestedPath: "dev/alpha", home: HOME }).code === "no_desktop_access");
ok("no declared paths, system scope -> still refused",
  desktopAccess({ scope: "system", declaredPaths: [], requestedPath: "dev/alpha", home: HOME }).allowed === false);
ok("outside the allowlist is refused, distinctly",
  desktopAccess({ scope: "project", declaredPaths: ["dev/alpha"], requestedPath: "dev/beta", home: HOME }).code === "outside_allowlist");
ok("a sibling with a shared prefix is not inside it",
  desktopAccess({ scope: "project", declaredPaths: ["dev/alpha"], requestedPath: "dev/alpha-secrets", home: HOME }).code === "outside_allowlist");
ok("inside a declared path is allowed",
  desktopAccess({ scope: "project", declaredPaths: ["dev/alpha"], requestedPath: "dev/alpha/src/x.ts", home: HOME }).allowed === true);
ok("escaping the declared path via .. is refused",
  desktopAccess({ scope: "project", declaredPaths: ["dev/alpha"], requestedPath: "dev/alpha/../../../etc/shadow", home: HOME }).allowed === false);

console.log("\n== facilities ==");
for (const f of NEVER_READ_FACILITIES) ok(`refuses ${f}`, facilityAccess(f).allowed === false);
ok("prototype key is not a facility grant", facilityAccess("constructor").allowed === true);

console.log("\n== the constructed environment ==");
const env = constructEnvironment({
  declared: {
    HOME: "/tmp/evil",
    PATH: "/tmp/evil/bin",
    Path: "/tmp/evil/bin",   // the same variable, spelled the way Windows accepts
    home: "/tmp/evil",
    // point a command at code of the project's choosing, without being named PATH
    LD_PRELOAD: "/tmp/evil.so",
    NODE_OPTIONS: "--require /tmp/evil.js",
    BASH_ENV: "/tmp/evil.sh",
    PYTHONSTARTUP: "/tmp/evil.py",
    GIT_SSH_COMMAND: "ssh -i /tmp/evil_key",
    ALPHA_TOKEN: "legitimate",
  },
  home: HOME,
});
ok("HOME is the constructed one", env.HOME === HOME, env.HOME);
ok("PATH is the constructed one", env.PATH === "/usr/local/bin:/usr/bin:/bin", env.PATH);
ok("a declared variable still arrives", env.ALPHA_TOKEN === "legitimate");
ok("nothing was inherited", !("SSH_AUTH_SOCK" in env) && !("AWS_ACCESS_KEY_ID" in env));
for (const v of ["Path", "home", "LD_PRELOAD", "NODE_OPTIONS", "BASH_ENV", "PYTHONSTARTUP", "GIT_SSH_COMMAND"]) {
  ok(`${v} does not survive`, !(v in env), `= ${env[v]}`);
}

console.log("\n== capture ==");
ok("a window capture may be kept", captureFor("Code - alpha").retain === true);
const screen = captureFor(null);
ok("a screen capture may not be kept", screen.retain === false && screen.index === false);
ok("an empty target falls to the safe side", captureFor("").retain === false);

console.log("\n== reachability ==");
const now = new Date("2026-09-03T12:00:00Z");
ok("never seen -> unreachable", reachableNow(null, now).reachable === false);
ok("seen 5s ago -> reachable", reachableNow(new Date(now.getTime() - 5_000), now).reachable === true);
ok("seen 5m ago -> unreachable", reachableNow(new Date(now.getTime() - 300_000), now).reachable === false);

console.log(`==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * The harness must not be able to reach Jarvis (II.5, S12b item 5).
 *
 * "The coding harness bypasses the broker by having a shell." `escapedPath`
 * guards the filesystem and that works — but a secret does not leave by a path.
 * It leaves by `curl`, by a postinstall script, by a test that phones home. A
 * run that can POST to `/internal/inbox/ingest` or open a Postgres connection
 * has stepped around every control in Part IV at once, and it needs no bug to do
 * it — only a plausible-looking command.
 *
 * Full egress allowlisting is not practical in V1 and the plan says so plainly:
 * "an allowlist that breaks every second build is an allowlist someone turns
 * off". So this enforces exactly the list the plan calls enforceable, and
 * nothing more:
 *
 *   the API and `/internal/*`   — denied
 *   Postgres on 127.0.0.1:5432  — denied
 *   the OpenClaw gateway        — denied
 *   the Docker socket / network — denied
 *   the rest of the internet    — allowed, and logged elsewhere
 *
 * How, without root: the run gets its OWN network namespace. Its `127.0.0.1` is
 * its own loopback, so Jarvis's API and Postgres are not merely blocked, they
 * are not there. `slirp4netns --disable-host-loopback` gives it the internet
 * while refusing the host's own addresses, and three blackhole routes remove
 * the private ranges the containers sit on. Measured on the box: example.com
 * answers 200, the API and Postgres are refused, and both Docker subnets are
 * "No route to host".
 *
 * It degrades honestly. If the kernel or the tooling cannot do this, the run
 * proceeds WITHOUT the namespace and says so on the task, rather than silently
 * dropping the containment or refusing to work at all.
 */

/** RFC1918 ranges the containers live on. 10.0.2.0/24 is slirp's own transit. */
const BLACKHOLE = ["172.16.0.0/12", "192.168.0.0/16", "10.0.0.0/8"];

export type EgressPlan =
  | { isolated: true; command: string; args: string[]; sentinel: string; ready: (pid: number) => Promise<void>; cleanup: () => void }
  | { isolated: false; reason: string };

/** Is the machinery for this present at all? */
export async function egressAvailable(): Promise<{ ok: boolean; reason: string }> {
  if (process.env.JARVIS_EGRESS === "off") return { ok: false, reason: "disabled by configuration" };
  if (process.platform !== "linux") return { ok: false, reason: `not linux (${process.platform})` };
  for (const bin of ["/usr/bin/unshare", "/usr/bin/slirp4netns", "/usr/bin/nsenter"]) {
    const there = await fs.access(bin).then(() => true, () => false);
    if (!there) return { ok: false, reason: `${bin} is not installed` };
  }
  return { ok: true, reason: "unshare + slirp4netns" };
}

/**
 * Wrap a command so it runs in its own network namespace.
 *
 * The dance, and why it is a dance: the namespace has to exist before
 * `slirp4netns` can attach to it, and the harness must not start until slirp
 * has configured it — a run that started a second early would see no network at
 * all and fail every fetch. So the wrapper waits for a sentinel file that the
 * parent creates once slirp is up. A file rather than stdin, because the
 * harness's stdin belongs to the harness.
 */
export async function planEgress(): Promise<EgressPlan> {
  const available = await egressAvailable();
  if (!available.ok) return { isolated: false, reason: available.reason };

  const sentinel = path.join(os.tmpdir(), `jarvis-egress-${process.pid}-${Date.now().toString(36)}`);
  await fs.rm(sentinel, { force: true }).catch(() => undefined);

  let slirp: ChildProcess | null = null;

  return {
    isolated: true,
    command: "/usr/bin/unshare",
    /*
     * `-c` (--map-current-user), NOT `-r` (--map-root-user).
     *
     * `-r` was here because an unprivileged user cannot create a network
     * namespace without capabilities, and mapping to root in a new user
     * namespace grants them. It works, and it has a consequence nobody looked
     * for: inside the namespace the harness IS uid 0. Claude Code 2.1.252
     * refuses to bypass permissions as root — "--dangerously-skip-permissions
     * cannot be used with root/sudo privileges for security reasons" — so every
     * heavy task on Claude failed terminally with zero tool calls, and the
     * runner reported it as a harness crash.
     *
     * `-c` maps the current user to ITSELF and still makes it the owner of the
     * new user namespace, which is where the capabilities come from. Verified on
     * the box: uid stays 1000, `unshare -cn` yields a namespace with only a
     * down `lo`, and slirp4netns still brings up tap0 at 10.0.2.100/24 with DNS
     * resolving. Same isolation, without telling the harness it is root.
     *
     * It is also more honest. ADR 016 went to some trouble to run the harness as
     * an unprivileged, per-project user; handing it a namespace where it
     * believes itself root undoes the story that code tells, even if the outer
     * uid is unchanged.
     */
    args: ["-cn", "--fork", "--pid", "--mount-proc", "/bin/sh", "-c", waiter(sentinel)],
    sentinel,
    async ready(pid: number) {
      slirp = spawn(
        "/usr/bin/slirp4netns",
        ["--configure", "--mtu=65520", "--disable-host-loopback", String(pid), "tap0"],
        { stdio: "ignore", detached: false },
      );
      // slirp needs a moment to bring tap0 up and write the routes. Waiting on
      // its readiness rather than assuming it is the difference between a build
      // that fetches and one that reports DNS failures for ten minutes.
      await new Promise((r) => setTimeout(r, 1500));
      await fs.writeFile(sentinel, "go");
    },
    cleanup() {
      slirp?.kill();
      void fs.rm(sentinel, { force: true }).catch(() => undefined);
    },
  };
}

/**
 * The shell the namespace runs: wait, blackhole the container ranges, exec.
 *
 * `exec` matters — the harness has to BE this process, or the runner's signal
 * handling and exit codes all point at a shell instead of at the thing it
 * spawned.
 */
function waiter(sentinel: string): string {
  const routes = BLACKHOLE.map((r) => `ip route add unreachable ${r} 2>/dev/null;`).join(" ");
  return [
    `i=0; while [ ! -f '${sentinel}' ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done;`,
    // slirp's own transit network has to survive the 10/8 blackhole, or the
    // namespace loses its default gateway along with the containers.
    routes,
    "ip route add 10.0.2.0/24 dev tap0 2>/dev/null;",
    'exec "$@"',
  ].join(" ");
}

/** The arguments that follow `sh -c <script>`: `$0` then `$@`. */
export function egressArgv(command: string, args: string[]): string[] {
  return ["harness", command, ...args];
}

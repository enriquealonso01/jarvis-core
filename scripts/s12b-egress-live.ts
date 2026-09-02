/**
 * S12b item 5 — the harness cannot reach Jarvis, proved at the network layer.
 *
 * The plan's test, in its own words: "`/internal/*`, Postgres and the gateway
 * all refused AT THE NETWORK LAYER. An application-layer refusal proves the
 * request arrived."
 *
 * So this does not check for a 403. It checks that the connection cannot be
 * made at all — and it does it by running commands through the SAME wrapper the
 * runner spawns the harness with, rather than through a copy of it.
 *
 * Runs on the box: it needs `unshare`, `slirp4netns` and a real Jarvis to fail
 * to reach.
 *
 *   node --import tsx scripts/s12b-egress-live.ts
 */
import { spawn } from "node:child_process";
import { egressArgv, egressAvailable, planEgress } from "../src/egress.js";

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

/**
 * Run a shell command the way the runner runs the harness: inside the
 * namespace, through `planEgress`, with slirp brought up against its pid.
 */
async function inNamespace(script: string): Promise<{ out: string; code: number | null }> {
  const plan = await planEgress();
  if (!plan.isolated) return { out: `NOT ISOLATED: ${plan.reason}`, code: -1 };
  const child = spawn(
    plan.command,
    [...plan.args, ...egressArgv("/bin/sh", ["-c", script])],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  if (child.pid) await plan.ready(child.pid);
  const code = await new Promise<number | null>((r) => child.on("close", r));
  plan.cleanup();
  return { out: out.trim(), code };
}

/** The same command on the host, for the comparison that makes it mean anything. */
async function onHost(script: string): Promise<string> {
  const child = spawn("/bin/sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  await new Promise((r) => child.on("close", r));
  return out.trim();
}

const REACH = (target: string) =>
  `timeout 4 bash -c '</dev/tcp/${target}' >/dev/null 2>&1 && echo OPEN || echo REFUSED`;

async function main(): Promise<void> {
  console.log("########## the machinery is there ##########\n");
  const available = await egressAvailable();
  check("unshare and slirp4netns are installed", true, available.ok);
  console.log(`  ${available.reason}`);
  if (!available.ok) throw new Error(available.reason);

  console.log("\n########## and it is still not root in there ##########\n");
  {
    /*
     * The namespace used to be created with `unshare -r`, which maps the caller
     * to uid 0 inside it. That is the ordinary way to get the capabilities a
     * network namespace needs, and it had a consequence nobody was looking for:
     * Claude Code 2.1.252 refuses `--permission-mode bypassPermissions` when it
     * finds itself running as root, so EVERY heavy task on Claude failed
     * terminally with zero tool calls and a stderr line about sudo.
     *
     * `-c` maps the user to itself and still owns the namespace. This asserts
     * the identity, because the network assertions below passed happily
     * throughout — isolation was never the thing that broke.
     */
    const who = await inNamespace(`id -u`);
    console.log(`  uid inside the namespace: ${who.out}`);
    truthy("the harness is not uid 0 inside its own namespace", who.out !== "0");
    check("it is the same unprivileged user as outside", process.getuid?.().toString() ?? "?", who.out);
  }

  console.log("\n########## what the run can still do ##########\n");
  {
    const net = await inNamespace(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://example.com || echo FAILED`,
    );
    console.log(`  example.com -> ${net.out}`);
    check("the internet still works, or every build breaks", "200", net.out);

    const dns = await inNamespace(`getent hosts registry.npmjs.org >/dev/null && echo RESOLVED || echo NO_DNS`);
    check("and DNS resolves", "RESOLVED", dns.out);
  }

  console.log("\n########## what it cannot ##########\n");
  {
    const api = await inNamespace(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:8080/api/health || echo REFUSED`,
    );
    console.log(`  the API      -> ${api.out}`);
    truthy("the API on the host loopback is unreachable", !api.out.includes("200"));

    const internal = await inNamespace(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 4 -X POST http://127.0.0.1:8080/internal/inbox/ingest || echo REFUSED`,
    );
    console.log(`  /internal/*  -> ${internal.out}`);
    truthy(
      "and so is /internal/* — refused at the network layer, not by the HMAC",
      !/\b(200|401|403)\b/.test(internal.out),
    );

    const pg = await inNamespace(REACH("127.0.0.1/5432"));
    check("Postgres is unreachable", "REFUSED", pg.out);

    /*
     * The API container's OWN address, discovered rather than guessed.
     *
     * The first version of this aimed at the bridge gateway (172.18.0.1) and
     * passed with the blackhole routes REMOVED — nothing is listening on the
     * gateway, so "refused" proved nothing. A containment test has to aim at
     * something that would otherwise answer.
     */
    /*
     * Found by asking the network, not by asking Docker: this test runs as the
     * runner's own user, which is deliberately not in the `docker` group, so
     * `docker inspect` is refused — correctly, and that refusal is asserted a
     * few lines further down. So the address is discovered the way anything
     * else would discover it, by looking for something that answers.
     */
    const apiIp = (await onHost(
      `for ip in ${process.env.JARVIS_API_IP ?? ""} 172.18.0.2 172.18.0.3 172.18.0.4 172.18.0.5; do `
      + `if [ -n "$ip" ] && curl -s -o /dev/null --max-time 2 "http://$ip:8080/api/health"; then echo "$ip"; break; fi; done`,
    )).trim();
    console.log(`  the API container is at ${apiIp || "(unknown)"}`);
    truthy("the API container has an address to aim at", apiIp.length > 0);
    if (apiIp) {
      const direct = await inNamespace(
        `curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://${apiIp}:8080/api/health || echo REFUSED`,
      );
      console.log(`  container direct -> ${direct.out}`);
      truthy("the API container is unreachable on the Docker network", !direct.out.includes("200"));

      const fromHost = await onHost(
        `curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://${apiIp}:8080/api/health || echo REFUSED`,
      );
      console.log(`  the same address from the host -> ${fromHost}`);
      truthy("...and it DOES answer from the host, so the refusal is the containment",
        fromHost.includes("200") || fromHost.includes("401"));
    }

    /*
     * The host's own addresses, where `--disable-host-loopback` is what is
     * doing the work. `10.0.2.2` is slirp's alias for the host; the public
     * address is the machine itself.
     */
    const hostAlias = await inNamespace(
      "curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://10.0.2.2:8080/api/health || echo REFUSED",
    );
    console.log(`  the host via slirp -> ${hostAlias.out}`);
    truthy("the host itself is unreachable through slirp's alias", !hostAlias.out.includes("200"));

    /*
     * The Docker socket, and what is ACTUALLY stopping it.
     *
     * The unit says `InaccessiblePaths=-/var/run/docker.sock` and that line does
     * nothing: `/var/run` is a symlink to `/run`, and systemd cannot bind an
     * empty file over a socket inode anyway — measured both ways, the file is
     * still there inside the service's own mount namespace. What stops the
     * harness using it is unix permissions: the socket is `root:docker 0660`
     * and the runner's user is not in the `docker` group, so the connection is
     * refused.
     *
     * Both facts are asserted, because the second is the one doing the work and
     * a test that named the first would be testing a line that has no effect.
     */
    const group = await onHost("id -nG jarvis 2>/dev/null || echo none");
    console.log(`  jarvis is in: ${group}`);
    truthy("the runner's user is not in the docker group", !group.split(/\s+/).includes("docker"));

    const connect = await inNamespace(
      "curl -s --unix-socket /run/docker.sock http://x/version --max-time 3 -o /dev/null"
      + " -w '%{http_code}' 2>/dev/null || echo REFUSED",
    );
    console.log(`  docker socket -> ${connect.out}`);
    truthy("and a connection to the Docker socket is refused", !connect.out.includes("200"));
  }

  console.log("\n########## and the same commands DO work on the host ##########\n");
  {
    /*
     * Without this the test proves nothing: a namespace that refuses everything
     * because the service is down looks identical to one that refuses because
     * it is contained.
     */
    const api = await onHost(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:8080/api/health || echo REFUSED`,
    );
    console.log(`  the API on the host -> ${api}`);
    truthy("the API really is up and answering on the host", api.includes("200") || api.includes("401"));

    const pg = await onHost(REACH("127.0.0.1/5432"));
    check("and Postgres really is listening", "OPEN", pg);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(() => {
    console.log(`\n==== ${pass} passed, ${fail} failed ====`);
    process.exit(fail === 0 ? 0 : 1);
  });

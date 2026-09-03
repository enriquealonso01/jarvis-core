/**
 * S32 tier 2 — the rung that was declared and left unimplemented.
 *
 * `fetchtier.ts` shipped `fingerprinted` as a tier the ladder knew about and
 * skipped with a reason, because guessing which client Enrique meant by "Paw
 * HTTPS" "would produce a rung that looks present and fails in a way nobody
 * could distinguish from a site problem". BLOCKERS B8 answers it: powhttp, an
 * MCP server.
 *
 * Two things are asserted here and they are not the same thing:
 *
 *  - THE LADDER REACHES IT. The plan's test is "assert the escalation actually
 *    happens and is recorded", so it is asserted through `fetchByLadder` rather
 *    than by calling the tier directly - a rung that works when called and is
 *    never reached is the same as no rung.
 *
 *  - IT ESCALATES AND STOPS FOR THE RIGHT REASONS. 403 and 429 are a site
 *    deciding about the CLIENT; 404 is a decision about the PAGE. Getting the
 *    second one wrong sends a browser - the box's single heavy slot, ADR 007 -
 *    to be told 404 more expensively, which is the exact expense the ladder
 *    exists to avoid.
 *
 * And separately: a fetcher is the first sandboxed server here that legitimately
 * needs egress, which is what turned "which network" from theoretical into a
 * decision. `host` is refused rather than unused.
 */
import { fetchByLadder, httpTier, type HeavySlot } from "../src/fetchtier.js";
import { sandboxArgv, SANDBOX_NETWORKS } from "../src/mcp.js";
import { FETCH_NETWORK, powhttpTier } from "../src/powhttp.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SERVER = { image: "ghcr.io/usestring/powhttp-mcp:pinned", command: ["powhttp-mcp"] };

/** A stock client being refused on its fingerprint, before any content. */
const refusesStockClients = async () =>
  new Response("", { status: 403 });

/** What the server hands back, and what it was asked. */
function fakePowhttp(reply: unknown) {
  const seen: Record<string, unknown>[] = [];
  const call = async (args: Record<string, unknown>) => { seen.push(args); return reply; };
  return { call: call as never, seen };
}

async function main(): Promise<void> {
  console.log("1. the ladder actually climbs to it, and records that it did");
  const served = fakePowhttp({ status: 200, body: "<html>the page</html>" });
  const result = await fetchByLadder("https://example.test/thing", {
    impls: {
      http: httpTier(refusesStockClients as unknown as typeof fetch),
      fingerprinted: powhttpTier(SERVER, served.call),
    },
  });
  result.servedBy === "fingerprinted"
    ? ok("a site that refuses a stock client on 403 is served by tier 2")
    : bad(`servedBy=${result.servedBy}`);
  result.body === "<html>the page</html>" ? ok("with the page it returned") : bad(`body=${result.body}`);
  /*
   * "Assert the escalation actually happens and is RECORDED." A rung that serves
   * the page while the attempt list claims the ladder stopped at HTTP leaves a
   * slow fetch unexplainable afterwards, which is the thing the record is for.
   */
  const httpAttempt = result.attempts.find((a) => a.tier === "http");
  httpAttempt?.outcome === "refused" && httpAttempt.reason.includes("403")
    ? ok(`and the rung below is recorded as refused: ${httpAttempt.reason}`)
    : bad(`http attempt recorded as ${JSON.stringify(httpAttempt)}`);
  result.attempts.some((a) => a.tier === "fingerprinted" && a.outcome === "served")
    ? ok("and tier 2 is recorded as the one that served it")
    : bad("the escalation is not in the record");
  !result.attempts.some((a) => a.tier === "fingerprinted" && a.reason.includes("not configured"))
    ? ok("the rung no longer reports itself as unconfigured")
    : bad("the tier is still being skipped as unconfigured");

  console.log("");
  console.log("2. what it is handed, and what it is not");
  const inputs = served.seen[0];
  inputs.network === FETCH_NETWORK && FETCH_NETWORK !== "none"
    ? ok(`it gets egress, and only egress: ${String(inputs.network)}`)
    : bad(`network=${String(inputs.network)}`);
  /*
   * Every other sandboxed server here mounts one project read-only. A fetcher
   * has no business reading any of them, and the way to be sure is not to hand
   * it a path at all.
   */
  inputs.projectDir === null
    ? ok("and no project directory, so there is nothing of his for it to read")
    : bad(`projectDir=${String(inputs.projectDir)}`);
  (inputs.input as Record<string, unknown>).url === "https://example.test/thing"
    ? ok("it is asked for the URL the ladder was asked for")
    : bad(`input=${JSON.stringify(inputs.input)}`);

  console.log("");
  console.log("3. a decision about the page stops the ladder; one about the client does not");
  const browserRan = { count: 0 };
  const slot: HeavySlot = { heldBy: "s32-tier2-test", acquiredAt: new Date() };
  const ladderWithBrowser = (tier2Reply: unknown) => ({
    impls: {
      http: httpTier(refusesStockClients as unknown as typeof fetch),
      fingerprinted: powhttpTier(SERVER, fakePowhttp(tier2Reply).call),
      browser: async () => {
        browserRan.count += 1;
        return { ok: true as const, body: "<html>expensive</html>", status: 200 };
      },
    },
    heavySlot: slot,
  });

  browserRan.count = 0;
  const gone = await fetchByLadder("https://example.test/missing", ladderWithBrowser({ status: 404 }));
  browserRan.count === 0
    ? ok("a 404 from tier 2 does not send a browser to be told 404 more expensively")
    : bad("THE HEAVY SLOT WAS SPENT ON A PAGE THAT DOES NOT EXIST");
  gone.servedBy === null && gone.attempts.some((a) => a.tier === "fingerprinted" && a.reason.includes("final"))
    ? ok("and the record says the answer was final")
    : bad(`404 handling: ${JSON.stringify(gone.attempts)}`);

  browserRan.count = 0;
  const blocked = await fetchByLadder("https://example.test/hard", ladderWithBrowser({ status: 429 }));
  browserRan.count === 1 && blocked.servedBy === "browser"
    ? ok("while a 429 — a decision about the client — does escalate to the browser")
    : bad(`429 escalation: servedBy=${blocked.servedBy}, browser ran ${browserRan.count}x`);

  console.log("");
  console.log("4. replies that are not answers");
  const cases: [string, unknown, string][] = [
    ["a 200 with no body", { status: 200 }, "no body"],
    ["no status at all", { body: "hello" }, "no status"],
    ["prose instead of a result", { content: [{ type: "text", text: "I could not do that" }] }, "not a fetch result"],
    ["the server reporting its own failure", { error: "tls handshake failed" }, "reported"],
  ];
  for (const [label, reply, expect] of cases) {
    const out = await powhttpTier(SERVER, fakePowhttp(reply).call)("https://example.test/x");
    !out.ok && out.retryable && out.reason.includes(expect)
      ? ok(`${label} escalates rather than being served: ${out.reason}`)
      : bad(`${label} produced ${JSON.stringify(out)}`);
  }
  /*
   * The wrapped-JSON shape is the one MCP servers actually use, so it has to be
   * read rather than assumed - otherwise every real reply lands in the case
   * above and tier 2 never serves anything.
   */
  const wrapped = await powhttpTier(SERVER, fakePowhttp({
    content: [{ type: "text", text: JSON.stringify({ status: 200, body: "<html>wrapped</html>" }) }],
  }).call)("https://example.test/x");
  wrapped.ok && wrapped.body === "<html>wrapped</html>"
    ? ok("while a result wrapped in MCP's text content is read, not discarded")
    : bad(`wrapped reply produced ${JSON.stringify(wrapped)}`);
  const threw = await powhttpTier(SERVER, (async () => { throw new Error("no such image"); }) as never)("https://x.test/");
  !threw.ok && threw.reason.includes("fingerprinting client failed")
    ? ok("and a container that will not start reads as the client failing, not the site refusing")
    : bad(`container failure produced ${JSON.stringify(threw)}`);

  console.log("");
  console.log("5. a fetcher needs egress, so 'which network' stopped being theoretical");
  const argv = sandboxArgv({ image: SERVER.image, command: SERVER.command, network: FETCH_NETWORK });
  argv.includes("--network") && argv[argv.indexOf("--network") + 1] === "bridge"
    ? ok("bridge is allowed: egress, with no route to the box's own services")
    : bad(`argv: ${argv.join(" ")}`);
  argv.includes("--read-only") && argv.includes("--cap-drop") && argv.includes("no-new-privileges")
    ? ok("and every other restriction survives being given a network")
    : bad("granting egress dropped another restriction");
  !argv.some((a) => a.startsWith("/") && a.includes(":/project"))
    ? ok("with no project mounted")
    : bad("a project volume reached the fetcher");

  /*
   * The value arrives from `connections.config`, which is data - so the type
   * says nothing at runtime and this is the last point before it becomes a
   * docker argument. --network host keeps every other restriction and loses the
   * one that matters: localhost in the container becomes localhost on the host,
   * where Postgres and the API are listening.
   */
  for (const forbidden of ["host", "container:jarvis-dev-postgres-1"]) {
    let threwOn = false;
    try {
      sandboxArgv({ image: SERVER.image, command: SERVER.command, network: forbidden as never });
    } catch {
      threwOn = true;
    }
    threwOn
      ? ok(`--network ${forbidden} is refused, not silently downgraded`)
      : bad(`SANDBOXED A SERVER ON ${forbidden}`);
  }
  !(SANDBOX_NETWORKS as readonly string[]).includes("host")
    ? ok(`the allowed set is closed: ${SANDBOX_NETWORKS.join(", ")}`)
    : bad("host is in the allow-list");
  sandboxArgv({ image: SERVER.image, command: SERVER.command })[
    sandboxArgv({ image: SERVER.image, command: SERVER.command }).indexOf("--network") + 1
  ] === "none"
    ? ok("and the default is still none, so this changed nothing for every other server")
    : bad("the default network changed");

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  process.exit(1);
});

/**
 * S31 — the Composio adapter, built last on purpose.
 *
 * The step's warning is that "two adapters are not an interface", and that
 * Composio is the one that would shape the seam around itself if it were built
 * first. So the seam was fixed by the four kinds that had to fit through it, and
 * this one fits through it too — which is why the plan's test is "remove the
 * Composio adapter and the other kinds keep working", asserted here by actually
 * removing it.
 *
 * The rest of this suite is about the one thing Composio does that no other
 * adapter here has to handle: IT ANSWERS HTTP 200 WHEN THE TOOL IT RAN FAILED.
 * Every other adapter can lean on the status code — `apiAdapter` throws on a
 * non-2xx precisely so the body of a 500 is never handed back as an answer — and
 * that check, applied here, passes. A failure returned as a value is audited as
 * a success and reported to him as one, which is the whole reason this file
 * checks an envelope instead.
 */
import {
  composioAdapter, composioBase, COMPOSIO_HOSTS, succeeded,
} from "../src/composio.js";
import { registeredKinds, unregisterAdapter, type ConnectionRow } from "../src/connectors.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const conn = (config: Record<string, unknown> = {}): ConnectionRow => ({
  id: "00000000-0000-0000-0000-0000000000c0",
  slug: "composio",
  kind: "composio",
  projectId: null,
  config: {
    connected_account_id: "acct_live_1",
    actions: ["GITHUB_CREATE_ISSUE", "GMAIL_SEND_EMAIL"],
    ...config,
  },
  timeoutMs: null,
  consecutiveTimeouts: 0,
});

const inv = (action: string, input: Record<string, unknown> = {}) => ({
  connectionSlug: "composio",
  action,
  projectId: null,
  input,
  secret: { api_key: "ck_live_THE_ACCOUNT_KEY" },
});

/** A fetch that records what it was asked and answers with a canned response. */
function fakeFetch(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = async (url: URL | string, init: RequestInit = {}) => {
    seen.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { f: f as unknown as typeof fetch, seen };
}

async function caught(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function main(): Promise<void> {
  console.log("1. a tool that worked");
  const good = fakeFetch(200, { successful: true, data: { number: 42, url: "https://github.test/i/42" } });
  const out = await composioAdapter(good.f).invoke(conn(), inv("GITHUB_CREATE_ISSUE", { title: "x" }));
  JSON.stringify(out) === JSON.stringify({ number: 42, url: "https://github.test/i/42" })
    ? ok("the envelope's data is what comes back, not the envelope")
    : bad(`returned ${JSON.stringify(out)}`);
  const sent = good.seen[0];
  sent.url.includes("/api/v2/actions/GITHUB_CREATE_ISSUE/execute")
    ? ok("addressed to the action it was asked for")
    : bad(`called ${sent.url}`);
  (sent.init.headers as Record<string, string>)["x-api-key"] === "ck_live_THE_ACCOUNT_KEY"
    ? ok("with the key the broker resolved — the adapter never reads the store itself")
    : bad("the key was not sent as the broker supplied it");
  JSON.parse(String(sent.init.body)).connectedAccountId === "acct_live_1"
    ? ok("and the connected account from the connection's config")
    : bad(`body: ${String(sent.init.body)}`);

  console.log("");
  console.log("2. HTTP 200 and the tool failed — the case every other adapter cannot have");
  /*
   * Asserted as a THROW rather than as a falsy return, because the layer above
   * records the outcome of what invoke() returns: a failure handed back as a
   * value is written into the audit as a success.
   */
  const failed = fakeFetch(200, {
    successful: false,
    error: "the GitHub token does not have issues:write",
  });
  const msg = await caught(() => composioAdapter(failed.f).invoke(conn(), inv("GITHUB_CREATE_ISSUE")));
  msg && msg.includes("failed at the provider")
    ? ok(`a 200 with successful:false raises: ${msg}`)
    : bad(`a failed tool run did not raise: ${msg}`);
  msg && msg.includes("issues:write")
    ? ok("and carries the provider's own words into the audit record")
    : bad("the reason the provider gave was dropped");

  /*
   * Absence is not success. A body with no verdict in it is a body whose success
   * nobody established, and defaulting that to true is how a silent failure
   * becomes a reported completion.
   */
  const silent = fakeFetch(200, { data: { anything: true } });
  const silentMsg = await caught(() => composioAdapter(silent.f).invoke(conn(), inv("GITHUB_CREATE_ISSUE")));
  silentMsg !== null
    ? ok("an envelope with no verdict at all is a failure, not a success by default")
    : bad("a response that never claimed success was treated as one");

  succeeded({ successfull: true } as never) && succeeded({ successful: true })
    ? ok("both spellings of the flag are read, because both appear in the wild")
    : bad("one of Composio's two spellings is not read");
  !succeeded({}) && !succeeded({ successful: "true" }) && !succeeded({ successful: 1 })
    ? ok("while a string, a number and an absence are none of them true")
    : bad("something other than boolean true counted as success");

  console.log("");
  console.log("3. the transport still matters");
  const unauth = fakeFetch(401, { error: "bad key" });
  const unauthMsg = await caught(() => composioAdapter(unauth.f).invoke(conn(), inv("GITHUB_CREATE_ISSUE")));
  unauthMsg?.includes("HTTP 401")
    ? ok("a 401 is a credential problem and says so")
    : bad(`401 produced ${unauthMsg}`);
  const junk = fakeFetch(200, "<html>a proxy error page</html>");
  const junkMsg = await caught(() => composioAdapter(junk.f).invoke(conn(), inv("GITHUB_CREATE_ISSUE")));
  junkMsg?.includes("not JSON")
    ? ok("and a 200 carrying an HTML error page is not an answer either")
    : bad(`non-JSON produced ${junkMsg}`);

  console.log("");
  console.log("4. the account key only ever goes to Composio");
  /*
   * Every other connection's base_url and credential belong to the same third
   * party. Here the credential is one account key reaching every tool Enrique
   * has connected, and connections.config is DATA — a row naming another host
   * would send that key to it, in a header, on the first invocation.
   */
  for (const host of [
    "https://backend.composio.dev.evil.test",
    "https://evil.test",
    "https://backend.composio.dev.attacker.example",
  ]) {
    const err = await caught(async () => composioBase(conn({ base_url: host })));
    err?.includes("refusing to send")
      ? ok(`${new URL(host).hostname} is refused`)
      : bad(`THE ACCOUNT KEY WOULD GO TO ${host}: ${err}`);
  }
  /*
   * A prefix test would accept the first of those. Hostname comparison against a
   * closed set is the only form of this check that is not quietly defeatable.
   */
  const httpErr = await caught(async () => composioBase(conn({ base_url: "http://backend.composio.dev" })));
  httpErr?.includes("https")
    ? ok("and plain http is refused: the key travels in a header")
    : bad(`http was accepted: ${httpErr}`);
  composioBase(conn()).hostname === COMPOSIO_HOSTS[0]
    ? ok(`the default is Composio's own host: ${COMPOSIO_HOSTS[0]}`)
    : bad("the default base_url is not Composio");
  composioBase(conn({ base_url: `https://${COMPOSIO_HOSTS[1]}` })).hostname === COMPOSIO_HOSTS[1]
    ? ok(`while the other real host is allowed: ${COMPOSIO_HOSTS[1]}`)
    : bad("a legitimate Composio host was refused");

  console.log("");
  console.log("5. only the actions this connection declares");
  const undeclared = fakeFetch(200, { successful: true, data: {} });
  const undeclaredMsg = await caught(() =>
    composioAdapter(undeclared.f).invoke(conn(), inv("GITHUB_DELETE_REPO")));
  undeclaredMsg?.includes("declares no action")
    ? ok("an action the connection never declared is refused")
    : bad(`an undeclared action ran: ${undeclaredMsg}`);
  undeclared.seen.length === 0
    ? ok("and refused BEFORE the call, so nothing happened at the provider")
    : bad("the request was sent and then judged");
  (await composioAdapter().declare(conn())).join(",") === "GITHUB_CREATE_ISSUE,GMAIL_SEND_EMAIL"
    ? ok("declare() lists exactly what the config names, sorted")
    : bad("declare() does not match the config");
  /*
   * Read from config rather than fetched. `declare` feeds tool classification,
   * and a list that changes under a network call would mean a tool's manifest
   * changes without anybody editing anything - which is what S31 pins
   * classifications against in the first place.
   */
  (await composioAdapter().declare(conn({ actions: undefined }))).length === 0
    ? ok("a connection declaring nothing can do nothing, rather than everything")
    : bad("a connection with no declared actions was not empty");

  console.log("");
  console.log("6. it is behind the interface, not the interface");
  registeredKinds().includes("composio")
    ? ok(`registered like any other kind: ${registeredKinds().join(", ")}`)
    : bad("the composio adapter is not registered");
  /*
   * The plan's own test: "remove the Composio adapter and the other kinds keep
   * working." Asserted by removing it.
   */
  unregisterAdapter("composio");
  const without = registeredKinds();
  !without.includes("composio") && ["api", "direct", "mcp", "native"].every((k) => without.includes(k))
    ? ok(`removed, and the others are untouched: ${without.join(", ")}`)
    : bad(`after removal: ${without.join(", ")}`);

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  process.exit(1);
});

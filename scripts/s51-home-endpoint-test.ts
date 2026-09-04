/**
 * S51, wired: the console has something to fetch.
 *
 * The map data shipped with S51 and nothing served it, so the console had nothing
 * to draw from. This asserts the endpoint over HTTP rather than the function
 * again — `homeMap` is already held by `s51-homemap-test`, and asserting it twice
 * would prove nothing about whether it is reachable.
 *
 * The properties that matter on the wire are the ones a drawing surface could get
 * wrong:
 *
 *   "**A node is a real object, an edge is a real relationship**... **If a point
 *    cannot be tied to a field, it does not belong on Home.**"
 *
 * So every node that crosses the wire carries its source table and a route, and
 * the suite checks that no point arrives without them — because a console given a
 * point with no href has no honest way to render it and will invent one.
 */
import { createPool } from "../src/db.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

/*
 * The same addressing every other HTTP suite here uses. From inside the runner
 * container `localhost` is the runner, not the API - so the first version failed
 * with "fetch failed" before reaching a single assertion.
 */
const API = process.env.S51_API ?? "http://api:8080";
const ORIGIN = process.env.JARVIS_ORIGIN ?? "http://localhost:8080";

type Node = {
  id: string; kind: string; label: string; state: string; href: string;
  source: string; weight: number;
};
type Home = {
  nodes: Node[]; edges: { from: string; to: string; rel: string }[];
  state: string; viewport: string; fits: { fits: boolean; overflow: number; why: string };
};

async function login(): Promise<string> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({
      email: process.env.JARVIS_OPERATOR_EMAIL ?? "dev@jarvis.local",
      password: process.env.JARVIS_OPERATOR_PASSWORD ?? "dev-password-1234",
    }),
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error(`could not log in: ${res.status}`);
  return cookie;
}

async function main(): Promise<void> {
  const cookie = await login();
  const get = async (path: string) => {
    const r = await fetch(`${API}${path}`, { headers: { Cookie: cookie, Origin: ORIGIN } });
    return { status: r.status, body: await r.json() as Home };
  };

  console.log("1. the console can fetch the map");
  const { status, body } = await get("/api/home");
  status === 200 ? ok("GET /api/home answers") : bad(`status ${status}`);
  Array.isArray(body.nodes) && body.nodes.length > 0
    ? ok(`${body.nodes.length} points came back`)
    : bad(`nodes: ${JSON.stringify(body.nodes)}`);
  body.nodes.some((n) => n.kind === "supervisor")
    ? ok("with the Supervisor among them")
    : bad("no hub on the wire");

  console.log("");
  console.log("2. nothing crosses the wire that cannot be drawn honestly");
  /*
   * A console handed a point with no route has no honest way to render it, and
   * will invent one. Checked on what ARRIVES rather than on what homeMap returns,
   * because serialisation is where a field quietly goes missing.
   */
  const routeless = body.nodes.filter((n) => !n.href && n.state !== "unknown");
  routeless.length === 0
    ? ok("every point has somewhere to go")
    : bad(`points with no route: ${routeless.map((n) => n.id).join(", ")}`);
  const sourceless = body.nodes.filter((n) => !n.source || !n.label);
  sourceless.length === 0
    ? ok("and every point names the field it came from, and is labelled")
    : bad(`points with no source or label: ${sourceless.map((n) => n.id).join(", ")}`);
  body.edges.every((e) => body.nodes.some((n) => n.id === e.from)
    && body.nodes.some((n) => n.id === e.to))
    ? ok("and every edge joins two points that actually arrived")
    : bad("an edge points at something that is not in the payload");

  console.log("");
  console.log("3. it answers the fitting question rather than leaving it to the client");
  const small = await get("/api/home?viewport=small");
  small.body.viewport === "small"
    ? ok("a phone viewport is honoured")
    : bad(`viewport: ${small.body.viewport}`);
  typeof small.body.fits?.fits === "boolean" && typeof small.body.fits.why === "string"
    ? ok(`and the answer comes with its reason: "${small.body.fits.why}"`)
    : bad(`fits: ${JSON.stringify(small.body.fits)}`);
  /*
   * Whether the map fits is a question about the DATA, so the server answers it.
   * A client left to work it out will answer it differently on every surface, and
   * the plan's remedy - the legible list equivalent - is a decision, not a
   * rendering detail.
   */
  const desktop = await get("/api/home?viewport=desktop");
  desktop.body.fits.overflow <= small.body.fits.overflow
    ? ok("a desktop holds at least as many points as a phone")
    : bad("the desktop overflowed more than the phone");
  (await get("/api/home?viewport=nonsense")).body.viewport === "desktop"
    ? ok("and an unrecognised viewport falls back rather than erroring")
    : bad("a bad viewport was not handled");

  console.log("");
  console.log("4. it is behind the session, like everything else");
  const anon = await fetch(`${API}/api/home`);
  anon.status === 401 || anon.status === 403
    ? ok(`unauthenticated is refused (${anon.status})`)
    : bad(`the map was served to nobody: ${anon.status}`);

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  await pool.end().catch(() => undefined);
  process.exit(1);
});

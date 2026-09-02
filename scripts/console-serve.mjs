#!/usr/bin/env node
/**
 * Serve the Control Center export on the same origin as the dev API.
 *
 * In production Caddy serves `/opt/jarvis/control-center` and reverse-proxies
 * `/api` to Fastify, so every fetch in the console is a same-origin relative
 * path. Locally there is no Caddy, and pointing the console at a different
 * origin would change what is being tested: the cookie is `SameSite`, so a
 * cross-origin console is logged out and the page renders its empty state no
 * matter what is in the database.
 *
 * So this is the smallest thing that reproduces the production shape — static
 * files from `out/`, everything under /api and /internal proxied through to the
 * dev API, one origin.
 *
 *   node scripts/console-serve.mjs [--port 8090] [--out ../jarvis-control-center/out]
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(arg("port", "8090"));
const OUT = path.resolve(arg("out", "../jarvis-control-center/out"));
const API = arg("api", "http://127.0.0.1:8080");

if (!fs.existsSync(path.join(OUT, "index.html"))) {
  console.error(`no index.html under ${OUT} — run \`pnpm build\` in the console repo first`);
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * In production Caddy serves the console and the API from ONE origin, so the
 * browser's `Origin` header is the origin the API checks against. Here the page
 * is on a test port, so every endpoint that enforces the origin — approvals,
 * grants, the broker, adding context to a task — answered 403, and the journeys
 * that used them looked like product bugs.
 *
 * Rewriting it reproduces production rather than disabling a check: the API's
 * CSRF guard still runs, against exactly the value it would see in production.
 */
const ORIGIN = arg("origin", process.env.JARVIS_ORIGIN ?? "http://localhost:8080");

function proxy(req, res) {
  const target = new URL(req.url, API);
  const headers = { ...req.headers, host: target.host };
  if (headers.origin) headers.origin = ORIGIN;
  if (headers.referer) headers.referer = `${ORIGIN}/`;
  const upstream = http.request(
    target,
    { method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `dev api unreachable: ${err.message}` }));
  });
  req.pipe(upstream);
}

function serve(req, res) {
  // `trailingSlash: true` in next.config means /queue/ maps to queue/index.html.
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(OUT, rel);
  // Never serve outside the export, however the path was written.
  if (!file.startsWith(OUT)) {
    res.writeHead(403).end("no");
    return;
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      // Not a 404 page: the console is a static export, so a missing route is a
      // build problem and should look like one.
      res.writeHead(404, { "content-type": "text/plain" }).end(`no such file: ${rel}`);
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  });
}

http
  .createServer((req, res) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/internal") || req.url.startsWith("/webhooks")) {
      proxy(req, res);
      return;
    }
    serve(req, res);
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`console on http://127.0.0.1:${PORT}  (static ${OUT}, api ${API})`);
  });

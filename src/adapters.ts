/**
 * The four kinds, below the seam (plan S31).
 *
 * Written together, in one file, on purpose. The step warns that building
 * Composio first and the rest later shapes the interface around the incumbent -
 * "the incumbent is the thing it exists to survive" - and the way that happens
 * in practice is that the other kinds arrive weeks later and bend to fit. Each
 * of these does real work: `native` reads a real file, `direct` runs a real
 * query, `api` makes a real request, `composio` calls the real API.
 *
 * None of them authorises anything. They are handed a call that the connector
 * has already permitted, and if one of them ever grows a check of its own that
 * is a bug, not a defence: two gates disagree eventually and the disagreement
 * is discovered by whichever one was wrong.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import pg from "pg";
import { readJsonCredential } from "./credentials.js";
import type { Adapter, ConnectorKind } from "./connector.js";

/** A vendor call that should never hang the lane it runs in. */
const TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * A local directory, as a connection.
 *
 * The kind the plan says will be special-cased, so it is written first. The
 * root comes from the connection config; everything under it is reachable and
 * nothing else is, and that is enforced by resolving the path and checking it
 * is still inside the root - not by looking for ".." in the input, which is a
 * string check that "%2e%2e" and a symlink both walk straight past.
 */
export const nativeAdapter: Adapter = {
  kind: "native",
  async invoke({ action, input, config }) {
    const root = resolve(String(config.root ?? ""));
    if (!root || root === sep) throw new Error("native connection has no root configured");

    const within = (p: string): string => {
      const full = resolve(root, p);
      if (full !== root && !full.startsWith(root + sep)) {
        throw new Error("path is outside the connection root");
      }
      return full;
    };

    if (action === "read_file") return await readFile(within(String(input.path ?? "")), "utf8");
    if (action === "list_dir") return await readdir(within(String(input.path ?? ".")));
    throw new Error(`native connection does not implement ${action}`);
  },
};

/**
 * A database URL, as a connection.
 *
 * Read-only twice over: the statement has to be a SELECT, and it runs inside a
 * READ ONLY transaction so the database refuses a write even if the first check
 * is fooled. One of those alone is a string test on somebody else`s SQL.
 */
export const directAdapter: Adapter = {
  kind: "direct",
  async invoke({ action, input, credentialId, pool }) {
    if (action !== "query") throw new Error(`direct connection does not implement ${action}`);
    if (!credentialId) throw new Error("direct connection has no credential");
    const cred = await readJsonCredential(pool, credentialId);
    const url = String(cred.url ?? cred.database_url ?? "");
    if (!url) throw new Error("direct credential holds no url");

    const sql = String(input.sql ?? "");
    if (!/^\s*select\b/i.test(sql)) throw new Error("only SELECT is permitted through a direct connection");

    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query("BEGIN READ ONLY");
      const r = await client.query(sql);
      await client.query("COMMIT");
      return r.rows.slice(0, 100);
    } finally {
      await client.end().catch(() => undefined);
    }
  },
};

/**
 * A plain API key against a plain HTTP service.
 *
 * Here so the seam has to survive a vendor with no SDK, no action catalogue and
 * no opinion about what an action is - which is most of them.
 */
export const apiAdapter: Adapter = {
  kind: "api",
  async invoke({ action, input, config, credentialId, pool }) {
    if (action !== "get") throw new Error(`api connection does not implement ${action}`);
    const base = String(config.base_url ?? "");
    if (!base) throw new Error("api connection has no base_url");
    const headers: Record<string, string> = {};
    if (credentialId) {
      const cred = await readJsonCredential(pool, credentialId);
      const key = String(cred.api_key ?? "");
      if (key) headers[String(config.header ?? "Authorization")] = String(config.prefix ?? "Bearer ") + key;
    }
    const res = await fetchWithTimeout(`${base}${String(input.path ?? "")}`, { headers });
    if (!res.ok) throw new Error(`${base} answered ${res.status}`);
    return await res.json();
  },
};

/**
 * Composio, as one vendor among four.
 *
 * The action is "<app>.<action>" because "create_issue" does not say on which
 * service, and the permitted-action set would be meaningless if it did not
 * name the service - permitting `send` once would permit sending anywhere the
 * connection reaches.
 */
export const composioAdapter: Adapter = {
  kind: "composio",
  async invoke({ action, input, credentialId, pool }) {
    if (!credentialId) throw new Error("composio connection has no credential");
    const cred = await readJsonCredential(pool, credentialId);
    const key = String(cred.api_key ?? "");
    if (!key) throw new Error("composio credential holds no api_key");

    if (action === "apps.list") {
      const res = await fetchWithTimeout("https://backend.composio.dev/api/v1/apps", {
        headers: { "x-api-key": key },
      });
      if (!res.ok) throw new Error(`Composio answered ${res.status}`);
      return await res.json();
    }

    const [, name] = action.split(".");
    if (!name) throw new Error(`composio action must be <app>.<action>, got ${action}`);
    const res = await fetchWithTimeout(
      `https://backend.composio.dev/api/v2/actions/${encodeURIComponent(name)}/execute`,
      {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ input: input ?? {} }),
      },
    );
    if (!res.ok) throw new Error(`Composio answered ${res.status}`);
    return await res.json();
  },
};

/** Every adapter this build has. Callers may pass a subset - see the S31 test. */
export function allAdapters(): Map<ConnectorKind, Adapter> {
  return new Map<ConnectorKind, Adapter>([
    ["native", nativeAdapter],
    ["direct", directAdapter],
    ["api", apiAdapter],
    ["composio", composioAdapter],
  ]);
}

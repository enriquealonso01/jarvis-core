/**
 * One way in, for every kind of connection (plan S31).
 *
 * The step's own warning is that two adapters are not an interface. Composio
 * and MCP are the two the plan names, and they are also the two that would
 * shape the seam around themselves if they were built first - so this is built
 * against the kinds nobody plans for:
 *
 *   connections:
 *     github:          { type: composio, connection_id: abc123 }
 *     postgres:        { type: direct,   secret: DATABASE_URL }
 *     custom_supplier: { type: api,      secret: SUPPLIER_API_KEY }
 *     local_files:     { type: native }
 *
 * `direct` and `native` are the ones that get wired wherever is convenient,
 * outside the scheme, and work - which is exactly how a connection ends up with
 * no permitted-action set and no audit row. They go first here for that reason.
 *
 * THE CHECK ORDER EXISTS ONCE. Part IV.4: connection exists -> project
 * allowlist -> role allowlist -> confidentiality -> spend -> always-confirm.
 * `checkConnectionAccess` already carries it, so `invokeConnector` calls that
 * and adapters never authorise anything themselves. IV.6b's first rule is why:
 * a gate that exists in three implementations is three gates, and one of them
 * is wrong.
 *
 * An adapter therefore does exactly one thing - perform the action - and never
 * decides whether it may. It cannot audit either: the audit row is written here
 * so that every kind produces the SAME row, which is what the plan asks to be
 * asserted rather than merely that all four kinds worked.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { audit, type Outcome } from "./audit.js";
import { checkConnectionAccess, type Denial } from "./isolation.js";
import { isAlwaysConfirm } from "./policy.js";

export type ConnectorKind = "composio" | "mcp" | "direct" | "api" | "native";

/** The connection row an adapter is allowed to see. No secret is in here. */
export type ConnectionRow = {
  id: string;
  slug: string;
  kind: string;
  projectId: string | null;
  config: Record<string, unknown>;
};

export type Invocation = {
  connectionSlug: string;
  /**
   * Required, and that is the point. The permitted-action set is only a set if
   * every invocation names which one - an interface that lets a caller omit it
   * would be a switch again for anybody who forgot.
   */
  action: string;
  projectId: string | null;
  taskId?: string | null;
  input?: Record<string, unknown>;
  /** A live approval, for an action that needs one. */
  approvalId?: string | null;
};

export type ConnectorResult =
  | { ok: true; output: unknown }
  | { ok: false; code: Denial["code"] | "connector.unsupported" | "connector.failed"; reason: string };

/**
 * What every kind implements, and all it implements.
 *
 * `declare` is what the manifest and the classifier read; `invoke` performs the
 * action. Authorising and auditing are deliberately absent - they live above,
 * once, for every kind.
 */
export type ConnectorAdapter = {
  kind: ConnectorKind;
  /** The actions this connection could perform, for classification and the UI. */
  declare(conn: ConnectionRow): Promise<string[]>;
  invoke(conn: ConnectionRow, inv: Invocation): Promise<unknown>;
};

const ADAPTERS = new Map<string, ConnectorAdapter>();

export function registerAdapter(a: ConnectorAdapter): void {
  ADAPTERS.set(a.kind, a);
}

/**
 * Only for the plan's test that Composio is behind the interface rather than
 * being it: "remove the Composio adapter and the other kinds keep working."
 */
export function unregisterAdapter(kind: ConnectorKind): boolean {
  return ADAPTERS.delete(kind);
}

export function registeredKinds(): string[] {
  return [...ADAPTERS.keys()].sort();
}

async function loadConnection(pool: pg.Pool, slug: string): Promise<ConnectionRow | null> {
  const r = await pool.query<{
    id: string; slug: string; kind: string; project_id: string | null; config: Record<string, unknown>;
  }>(
    `SELECT id, slug, kind, project_id, config FROM connections WHERE slug = $1`, [slug]);
  const c = r.rows[0];
  return c ? { id: c.id, slug: c.slug, kind: c.kind, projectId: c.project_id, config: c.config ?? {} } : null;
}

/**
 * Authorise once, invoke through the adapter, audit the same way for every kind.
 *
 * Every exit writes an audit row, including the refusals. A denial that leaves
 * no trace is indistinguishable from a call nobody made, and the plan asks for
 * a denial from this week to be visible on the Connections tab - which it can
 * only be if it was recorded.
 */
export async function invokeConnector(
  pool: pg.Pool,
  inv: Invocation,
): Promise<ConnectorResult> {
  const trail = async (outcome: Outcome, reason?: string) => {
    await audit(pool, {
      actor: "broker",
      action: "connector.invoke",
      target: `${inv.connectionSlug}:${inv.action}`,
      projectId: inv.projectId,
      outcome,
      reason: reason ?? null,
      taskId: inv.taskId ?? null,
      tool: inv.action,
      approvalId: inv.approvalId ?? null,
    });
  };

  const decision = await checkConnectionAccess(pool, {
    connectionSlug: inv.connectionSlug,
    projectId: inv.projectId,
    taskId: inv.taskId,
    action: inv.action,
  });
  if (!decision.allowed) {
    await trail("denied", decision.reason);
    return { ok: false, code: decision.code, reason: decision.reason };
  }

  /*
   * The last step of IV.4's order, and it belongs here rather than in
   * checkConnectionAccess: that function answers "may this reach the
   * credential", which the runner and routing also ask, and they are not
   * performing an action anybody could confirm. An always-confirm ACTION needs
   * a live approval, and only an invocation has one to offer.
   */
  if (isAlwaysConfirm(inv.action) && !inv.approvalId) {
    const reason = `${inv.action} always needs confirmation, and no approval was attached`;
    await trail("denied", reason);
    return { ok: false, code: "security.broker_deny", reason };
  }

  const conn = await loadConnection(pool, inv.connectionSlug);
  if (!conn) {
    // checkConnectionAccess already refuses an unknown connection, so reaching
    // here means it was deleted in between. Fail closed rather than assume.
    await trail("denied", "connection disappeared between the check and the call");
    return { ok: false, code: "security.broker_deny", reason: "unknown connection" };
  }

  const adapter = ADAPTERS.get(conn.kind);
  if (!adapter) {
    const reason = `no adapter is registered for a ${conn.kind} connection`;
    await trail("failed", reason);
    return { ok: false, code: "connector.unsupported", reason };
  }

  try {
    const output = await adapter.invoke(conn, inv);
    await trail("allowed");
    return { ok: true, output };
  } catch (err) {
    /*
     * The adapter's message, not the adapter's exception. A failure from a
     * third-party client can carry a URL with a key in it, and this row is
     * read by a person on the Connections tab.
     */
    const reason = err instanceof Error ? err.message : "the connector failed";
    await trail("failed", reason);
    return { ok: false, code: "connector.failed", reason };
  }
}

/** What a connection can do, for the manifest, the console and the classifier. */
export async function declareActions(pool: pg.Pool, slug: string): Promise<string[]> {
  const conn = await loadConnection(pool, slug);
  if (!conn) return [];
  const adapter = ADAPTERS.get(conn.kind);
  return adapter ? adapter.declare(conn) : [];
}

/* ------------------------------------------------------------------ *
 * native — a local directory.
 *
 * The plan: "Test the kind nobody thought about — the native one — because it
 * is the one that will have been special-cased." It is also the one with no
 * vendor behind it, which is what makes it a good shape for the seam.
 * ------------------------------------------------------------------ */

export const nativeAdapter: ConnectorAdapter = {
  kind: "native",
  async declare() {
    return ["read", "list"];
  },
  async invoke(conn, inv) {
    const root = typeof conn.config.root === "string" ? conn.config.root : null;
    if (!root) throw new Error("this native connection has no root directory configured");

    /*
     * The path guard. A native connection is a directory, and the whole of its
     * isolation is that nothing reaches outside it - so the check is on the
     * RESOLVED path, not on the string the caller passed. "../" is the obvious
     * attempt; a symlink pointing out of the tree is the one that works when
     * only the string was checked, which is why realpath decides it.
     */
    const rel = typeof inv.input?.path === "string" ? inv.input.path : "";
    const target = path.resolve(root, rel);
    const realRoot = await fs.realpath(root);
    const within = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);
    if (!within(path.resolve(target))) {
      throw new Error("that path is outside this connection's directory");
    }

    if (inv.action === "list") {
      const entries = await fs.readdir(target, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
    }
    if (inv.action === "read") {
      // Resolved AFTER the file is known to exist, so a symlink inside the
      // directory that points outside it is caught rather than followed.
      const real = await fs.realpath(target);
      if (!within(real)) throw new Error("that path leaves this connection's directory");
      return await fs.readFile(real, "utf8");
    }
    throw new Error(`a native connection cannot ${inv.action}`);
  },
};

/* ------------------------------------------------------------------ *
 * direct — a secret handed to something that speaks its own protocol,
 * a DATABASE_URL being the plan's example.
 * ------------------------------------------------------------------ */

export const directAdapter: ConnectorAdapter = {
  kind: "direct",
  async declare() {
    return ["use"];
  },
  async invoke(conn, inv) {
    if (inv.action !== "use") throw new Error(`a direct connection cannot ${inv.action}`);
    const envVar = typeof conn.config.secret === "string" ? conn.config.secret : null;
    if (!envVar) throw new Error("this direct connection names no secret");
    const value = process.env[envVar];
    if (!value) throw new Error(`${envVar} is not set on this host`);
    /*
     * The VALUE is returned to the caller that was authorised to have it, and
     * nothing about it is returned anywhere else. The audit row above records
     * the connection and the action; it never sees this.
     */
    return { secret: value };
  },
};

registerAdapter(nativeAdapter);
registerAdapter(directAdapter);

/**
 * One way to reach anything outside Jarvis (plan S31).
 *
 * The step is explicit that two adapters are not an interface: "an interface
 * that only Composio and MCP fit is a coincidence, not an abstraction". So the
 * seam is built against four kinds at once, and the two nobody plans for -
 * `direct` (a database URL) and `native` (a local directory) - go through the
 * same authorise path, produce the same audit row, and are denied across
 * projects in the same way. They are the kinds that would otherwise get wired
 * up wherever was convenient, which is how a connection ends up with no
 * allowlist and no audit trail.
 *
 * The check order exists ONCE, and mostly it already existed: authorise() calls
 * `checkConnectionAccess`, the gate S12 built - connection exists, scope,
 * broker-only profiles, project allowlist, confidentiality. Re-implementing
 * that here per adapter is the failure IV.6b names: "a gate that exists in
 * three implementations is three gates, and one of them is wrong". What this
 * module adds is the step S31 introduces - the permitted ACTION - and it adds
 * it in one place, after the existing checks and before any adapter runs.
 *
 * What is deliberately NOT here: the adapters do not audit. Auditing is done by
 * invoke() around them, because an adapter that writes its own audit row is an
 * adapter that can forget to, and the whole point of the seam is that the
 * record does not depend on which vendor answered.
 */
import type pg from "pg";
import { checkConnectionAccess, recordDenial, type BrokerDecision } from "./isolation.js";
import { audit } from "./audit.js";
import { raiseIssue } from "./notify.js";

export type ConnectorKind = "composio" | "mcp" | "direct" | "native" | "api";

export type Invocation = {
  connectionSlug: string;
  /** As the adapter names it: "github.create_issue", "read_file", "query". */
  action: string;
  projectId: string | null;
  role?: string | null;
  taskId?: string | null;
  input?: Record<string, unknown>;
  /** Override the default call timeout. Tests use it; callers rarely should. */
  timeoutMs?: number;
};

export type Refusal = { ok: false; code: string; reason: string };
export type Success = { ok: true; output: unknown };
export type ConnectorResult = Refusal | Success;

/**
 * What an adapter has to provide, and nothing more.
 *
 * No authorisation, no auditing, no project logic: an adapter that could refuse
 * a call would be a second gate, and one of two gates is always the wrong one.
 * It receives a call that has already been permitted and does the vendor-shaped
 * work of making it.
 */
export type Adapter = {
  kind: ConnectorKind;
  invoke(ctx: {
    action: string;
    input: Record<string, unknown>;
    config: Record<string, unknown>;
    credentialId: string | null;
    pool: pg.Pool;
  }): Promise<unknown>;
};

type ConnRow = {
  id: string;
  slug: string;
  kind: string;
  config: Record<string, unknown>;
  credential_id: string | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
  consecutive_timeouts: number;
};

/**
 * How long any one call may take before the lane is considered hostage.
 *
 * Applies to every kind, not only MCP. The plan raises this about a hanging MCP
 * server, but nothing about the failure is MCP-shaped: a database that never
 * answers and an HTTP endpoint that accepts a connection and then goes quiet
 * both hold the heavy lane exactly as effectively. A timeout that covers only
 * the vendor everyone was worried about is a timeout with a hole in it.
 */
export const CALL_TIMEOUT_MS = 20_000;

/** Two in a row is broken. One is a bad afternoon. */
export const TIMEOUTS_BEFORE_DISABLE = 2;

class TimedOut extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimedOut(`no answer within ${ms}ms`)), ms);
    work.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Is this action permitted on this connection, and at what level.
 *
 * Separated from invoke() so the answer can be asked without making the call -
 * the harness needs to know what it may do before it decides what to try, and
 * a "try it and see" design turns every refusal into a side effect somebody has
 * to clean up.
 */
export async function authorise(
  pool: pg.Pool,
  args: Invocation,
): Promise<(BrokerDecision & { level?: number; connection?: ConnRow })> {
  const decision = await checkConnectionAccess(pool, {
    connectionSlug: args.connectionSlug,
    projectId: args.projectId,
    taskId: args.taskId ?? null,
    capability: `connector.${args.action}`,
  });
  if (!decision.allowed) return decision;

  const conn = await pool.query<ConnRow>(
    `SELECT id, slug, kind, config, credential_id, disabled_at, disabled_reason, consecutive_timeouts
       FROM connections WHERE slug = $1`,
    [args.connectionSlug],
  );
  const c = conn.rows[0];
  if (!c) return { allowed: false, code: "security.broker_deny", reason: "unknown connection" };

  /*
   * A disabled connection is refused before anything else is considered.
   * Checked here rather than at the call site so that every caller inherits it,
   * including the ones written after somebody forgot this existed.
   */
  if (c.disabled_at) {
    /*
     * Reported as an ordinary broker denial rather than a new code. The denial
     * vocabulary is part of the frozen taxonomy, and "disabled" is a reason a
     * broker says no, not a new kind of no - the sentence carries the detail.
     */
    return {
      allowed: false,
      code: "security.broker_deny",
      reason: `connection ${c.slug} is disabled: ${c.disabled_reason ?? "taken out of service"}`,
    };
  }

  /*
   * The permitted-action set. This is the assertion that separates a set from a
   * switch: a connection permitting one action does not permit a second action
   * on the same service, however plausible the second one looks and however
   * healthy the connection is.
   */
  const act = await pool.query<{ level: number }>(
    `SELECT level FROM connection_actions WHERE connection_id = $1 AND action = $2`,
    [c.id, args.action],
  );
  if (!act.rows[0]) {
    return {
      allowed: false,
      code: "security.broker_deny",
      reason: `connection ${c.slug} does not permit the action ${args.action}`,
    };
  }

  return { allowed: true, connectionId: c.id, authProfileId: null, level: act.rows[0].level, connection: c };
}

/**
 * Authorise, invoke, audit - in that order, for every kind.
 *
 * A Level 3 action is refused here rather than executed, because approval is
 * S14's path and inventing a second one inside the connector is how a system
 * ends up with two answers to "was this confirmed". The refusal names the level
 * so the caller can raise the approval and come back.
 */
export async function invoke(
  pool: pg.Pool,
  adapters: Map<ConnectorKind, Adapter>,
  args: Invocation,
): Promise<ConnectorResult> {
  const decision = await authorise(pool, args);

  if (!decision.allowed) {
    /*
     * Denials go through the broker`s own denial path rather than this module`s
     * audit helper. Reusing it is the same principle as reusing the gate: every
     * refusal in the system is recorded one way, and cross-project probing
     * raises its Issue whether it came through a connector or anywhere else.
     * The connection is named so a reviewer can find the refusal beside the
     * calls that succeeded - without it the row is addressed to the capability
     * and the connection it was aimed at is not in the record at all.
     */
    await recordDenial(pool, {
      denial: decision,
      capability: `connector.${args.action}`,
      projectId: args.projectId,
      taskId: args.taskId ?? null,
      connectionSlug: args.connectionSlug,
    });
    return { ok: false, code: decision.code, reason: decision.reason };
  }

  const c = decision.connection as ConnRow;
  const adapter = adapters.get(c.kind as ConnectorKind);
  if (!adapter) {
    /*
     * Recorded as a refusal rather than thrown. "Remove the Composio adapter
     * and the other kinds keep working" is one of this step`s tests, and it
     * only means anything if a missing adapter is an ordinary, audited no -
     * not an exception that takes the caller down with it.
     */
    await auditCall(pool, args, c, "refused", `no adapter for kind ${c.kind}`);
    return { ok: false, code: "connector.no_adapter", reason: `no adapter for kind ${c.kind}` };
  }

  if ((decision.level ?? 3) >= 3) {
    await auditCall(pool, args, c, "refused", "level 3 action needs confirmation");
    return {
      ok: false,
      code: "approval.required",
      reason: `${args.action} on ${c.slug} is classified level 3 and needs confirmation`,
    };
  }

  try {
    const output = await withTimeout(adapter.invoke({
      action: args.action,
      input: args.input ?? {},
      config: c.config ?? {},
      credentialId: c.credential_id,
      pool,
    }), args.timeoutMs ?? CALL_TIMEOUT_MS);

    /*
     * A call that answered clears the streak. Consecutive is the whole point:
     * without this reset the counter is cumulative, and a connection that
     * times out once a quarter is eventually disabled for being old rather
     * than for being broken.
     */
    if (c.consecutive_timeouts > 0) {
      await pool.query(`UPDATE connections SET consecutive_timeouts = 0 WHERE id = $1`, [c.id]);
    }
    await auditCall(pool, args, c, "invoked", null);
    return { ok: true, output };
  } catch (e: unknown) {
    const timedOut = e instanceof TimedOut;
    const reason = e instanceof Error ? e.message.slice(0, 300) : String(e);

    if (!timedOut) {
      await auditCall(pool, args, c, "failed", reason);
      return { ok: false, code: "connector.failed", reason };
    }

    const n = await pool.query<{ consecutive_timeouts: number }>(
      `UPDATE connections SET consecutive_timeouts = consecutive_timeouts + 1
        WHERE id = $1 RETURNING consecutive_timeouts`, [c.id]);
    const streak = n.rows[0]?.consecutive_timeouts ?? 1;

    if (streak >= TIMEOUTS_BEFORE_DISABLE) {
      /*
       * Disabled, with an Issue, rather than retried forever. The plan is
       * specific about which of those two it wants: a hanging server that keeps
       * being retried costs the heavy lane every time, and the cost is paid by
       * whatever task was unlucky enough to be next.
       */
      await pool.query(
        `UPDATE connections SET disabled_at = now(), disabled_reason = $2 WHERE id = $1`,
        [c.id, `timed out ${streak} times in a row`]);
      await raiseIssue(pool, {
        /*
         * An existing class, because the taxonomy is frozen and this is not a
         * new kind of failure - it is the one the taxonomy already calls a
         * crashed MCP server, or a degraded provider for everything else.
         */
        category: c.kind === "mcp" ? "mcp.crash" : "provider.degraded",
        service: "connector",
        owner: "provider",
        title: `[connector] ${c.slug} disabled after ${streak} timeouts`,
        dedupeKey: `connector.timeout:${c.slug}`,
        projectId: args.projectId,
        taskId: args.taskId ?? null,
        evidence: { connection: c.slug, kind: c.kind, action: args.action, streak },
        requiredAction:
          `${c.slug} stopped answering and has been taken out of service so it cannot hold the heavy `
          + `lane. Check the server, then clear disabled_at to bring it back.`,
      });
    }

    await auditCall(pool, args, c, "failed", `${reason}${streak >= TIMEOUTS_BEFORE_DISABLE ? " - disabled" : ""}`);
    return { ok: false, code: "connector.timeout", reason };
  }
}

/**
 * One audit row shape, whatever answered.
 *
 * The step asks for this specifically: "assert the audit rows are the same
 * shape, not merely that both worked". A native directory read and a Composio
 * call have to be reviewable side by side a month later, and they are not if
 * one of them records a different set of fields.
 */
async function auditCall(
  pool: pg.Pool,
  args: Invocation,
  c: ConnRow,
  outcome: "invoked" | "refused" | "failed",
  detail: string | null,
): Promise<void> {
  await audit(pool, {
    actor: "broker",
    action: `connector.${outcome}`,
    projectId: args.projectId,
    target: `${c.slug}:${args.action}`,
    outcome: outcome === "invoked" ? "allowed" : outcome === "refused" ? "denied" : "failed",
    reason: detail,
    taskId: args.taskId ?? null,
    tool: `connector.${args.action}`,
    extra: {
      kind: c.kind,
      connection: c.slug,
      connector_action: args.action,
    },
  });
}

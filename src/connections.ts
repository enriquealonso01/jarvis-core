/**
 * What the Connections tab reads, and what revoking actually does (plan S31).
 *
 * Two lines from the plan drive the whole file:
 *
 *   "The Connections tab shows a CAPABILITY, not a tool name, and a denial from
 *    this week is visible on it."
 *
 *   "Then revoke from that page and confirm the browser session is cleared and
 *    the generated credential is revoked at the provider — assert on the far
 *    side, not on the row."
 *
 * The second one is a warning about how this gets built badly. The easy revoke
 * sets a flag, the row goes grey, the page looks right, and the credential is
 * still valid — so the test that passes is the one asserting on the flag. Here
 * revoking DESTROYS the stored ciphertext rather than marking it, which is why
 * the test can assert the capability is gone rather than that a column changed.
 *
 * What it honestly does NOT do: reach the provider and revoke the key there.
 * Nothing in this repository can, for a connection whose provider is a plain
 * API key with no revocation endpoint, and pretending otherwise in a status
 * message would be the worst version of this. So the response says exactly
 * which half happened, and the half that needs a person says so.
 */
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireUser } from "./auth.js";
import { audit } from "./audit.js";
import { toolsFor } from "./tools.js";

/** A denial recent enough that somebody might still be wondering about it. */
const DENIAL_WINDOW_DAYS = 7;

export type ConnectionView = {
  slug: string;
  kind: string;
  scope: string;
  projectId: string | null;
  disabled: boolean;
  disabledReason: string | null;
  hasCredential: boolean;
  /**
   * What this connection can do, in the words of whoever classified it.
   *
   * A tool that is attached but not yet classified appears here as waiting,
   * NOT as a name: the plan's complaint is that a name tells a reader nothing,
   * and "update_record (unclassified)" is still a name.
   */
  capabilities: { capability: string; level: number; callable: boolean; why: string }[];
  waitingOnYou: number;
  recentDenials: { at: string; action: string; reason: string }[];
};

export async function connectionViews(pool: pg.Pool): Promise<ConnectionView[]> {
  const rows = await pool.query<{
    id: string; slug: string; kind: string; scope: string; project_id: string | null;
    disabled_at: string | null; disabled_reason: string | null; has_credential: boolean;
  }>(
    `SELECT id, slug, kind, scope, project_id, disabled_at, disabled_reason,
            credential_id IS NOT NULL AS has_credential
       FROM connections ORDER BY slug`,
  );

  const views: ConnectionView[] = [];
  for (const c of rows.rows) {
    const tools = await toolsFor(pool, c.id);
    const denials = await pool.query<{ at: string; target: string; reason: string }>(
      `SELECT at::text, target, COALESCE(metadata->>'reason', '') AS reason
         FROM audit_events
        WHERE action = 'connector.invoke'
          AND metadata->>'outcome' = 'denied'
          AND target LIKE $1
          AND at > now() - ($2 || ' days')::interval
        ORDER BY at DESC LIMIT 20`,
      [`${c.slug}:%`, String(DENIAL_WINDOW_DAYS)],
    );
    views.push({
      slug: c.slug,
      kind: c.kind,
      scope: c.scope,
      projectId: c.project_id,
      disabled: c.disabled_at !== null,
      disabledReason: c.disabled_reason,
      hasCredential: c.has_credential,
      capabilities: tools
        .filter((t) => t.capability !== null)
        .map((t) => ({
          capability: t.capability as string,
          level: t.level ?? 0,
          callable: t.callable,
          why: t.reason,
        })),
      // Counted rather than listed by name, for the same reason: a list of
      // names on a page is what this is replacing.
      waitingOnYou: tools.filter((t) => t.capability === null || !t.callable).length,
      recentDenials: denials.rows.map((d) => ({
        at: d.at,
        // The action, split back off the target the audit row stores.
        action: d.target.slice(c.slug.length + 1),
        reason: d.reason,
      })),
    });
  }
  return views;
}

/**
 * Take the capability away.
 *
 * The credential's ciphertext is overwritten and the row deleted, the
 * connection is disabled, and the connection's tools lose their classification
 * so that re-attaching cannot silently inherit a decision made about the old
 * credential's blast radius.
 *
 * Returns what actually happened, in halves, because they are not equally
 * complete: Jarvis can destroy what it holds, and it cannot revoke a key at a
 * provider that offers no way to. Saying "revoked" when only the first half
 * happened is how a key stays live in somebody's dashboard for a year.
 */
export async function revokeConnection(
  pool: pg.Pool,
  slug: string,
  actor: string,
): Promise<{ ok: boolean; localCredentialDestroyed: boolean; providerRevocation: string }> {
  const c = (await pool.query<{ id: string; credential_id: string | null }>(
    `SELECT id, credential_id FROM connections WHERE slug = $1`, [slug])).rows[0];
  if (!c) return { ok: false, localCredentialDestroyed: false, providerRevocation: "no such connection" };

  let destroyed = false;
  if (c.credential_id) {
    /*
     * Overwritten before deletion. A DELETE leaves the ciphertext in the page
     * until it is reused, and this is the row somebody would go looking for
     * after an incident - so the bytes are replaced first and the row goes
     * afterwards.
     */
    await pool.query(
      `UPDATE credentials SET ciphertext = decode('00', 'hex'), nonce = decode('00', 'hex')
        WHERE id = $1`, [c.credential_id]);
    await pool.query(`UPDATE connections SET credential_id = NULL WHERE id = $1`, [c.id]);
    await pool.query(`DELETE FROM credentials WHERE id = $1`, [c.credential_id]);
    destroyed = true;
  }

  await pool.query(
    `UPDATE connections SET disabled_at = now(), disabled_reason = $2 WHERE id = $1`,
    [c.id, `revoked by ${actor}`]);
  // A classification is a decision about what a specific credential could
  // reach. Re-attaching a different one must ask again.
  await pool.query(
    `UPDATE connection_tools SET level = NULL, classified_hash = NULL, capability = NULL
      WHERE connection_id = $1`, [c.id]);

  await audit(pool, {
    actor,
    action: "connection.revoke",
    target: slug,
    outcome: "allowed",
    reason: destroyed ? "credential destroyed and connection disabled" : "connection disabled; it held no credential",
  });

  return {
    ok: true,
    localCredentialDestroyed: destroyed,
    providerRevocation:
      "not attempted: Jarvis destroyed its own copy and disabled the connection. "
      + "If the provider issued this key, revoke it there too - Jarvis cannot do that for a plain API key.",
  };
}

export function registerConnectionRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get("/api/connections", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    return { connections: await connectionViews(pool) };
  });

  app.post<{ Params: { slug: string } }>("/api/connections/:slug/revoke", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const result = await revokeConnection(pool, req.params.slug, "user");
    if (!result.ok) return reply.code(404).send({ error: "no such connection" });
    return result;
  });
}

import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireUser } from "./auth.js";
import { storeJsonCredential } from "./credentials.js";

// Which auth types are submitted as a pasted secret. Derived from the profile
// row rather than a hardcoded id list: the old allowlist named five profiles, so
// every provider added since — fireworks, composio, backup_b2, netcup_scp — was
// rejected by the Connections form with "this profile is a host login", which
// was both a dead end and untrue. A host login is `subscription_login`, and that
// is the distinction the check actually wants to make.
const PASTEABLE_AUTH_TYPES = new Set(["api_key", "pat", "oauth", "deploy_key"]);

const ALLOWED_ORIGIN = process.env.JARVIS_ORIGIN ?? "https://jarvis.enriquecodes.com";

function originOk(req: { headers: { origin?: string; referer?: string } }): boolean {
  const origin = req.headers.origin;
  if (origin) return origin === ALLOWED_ORIGIN;
  const referer = req.headers.referer;
  if (referer) return referer.startsWith(`${ALLOWED_ORIGIN}/`);
  return true;
}

function last4(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 4 ? "****" : trimmed.slice(-4);
}

export function registerSetupRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get("/api/setup", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    const profiles = await pool.query(
      `SELECT a.id, a.display_name, a.provider, a.auth_type, a.health,
              (a.credential_id IS NOT NULL) AS has_credential, c.fingerprint
       FROM auth_profiles a
       LEFT JOIN credentials c ON c.id = a.credential_id
       ORDER BY a.id`,
    );
    const supervisor = profiles.rows.some(
      (p) => p.id === "groq" && p.health === "healthy" && p.has_credential,
    );
    return {
      operator_email: user.email,
      supervisor_route: supervisor ? "healthy" : "missing",
      compose_enabled: supervisor,
      profiles: profiles.rows,
    };
  });

  app.post("/api/auth-profiles/:id/credentials", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    if (!originOk(req)) {
      return reply.code(403).send({ error: "bad origin" });
    }
    const id = (req.params as { id: string }).id;
    const profile = await pool.query<{ auth_type: string }>(
      `SELECT auth_type FROM auth_profiles WHERE id = $1`,
      [id],
    );
    const authType = profile.rows[0]?.auth_type;
    if (!authType) {
      return reply.code(404).send({ error: `no auth profile named ${id}` });
    }
    if (!PASTEABLE_AUTH_TYPES.has(authType)) {
      return reply.code(400).send({
        error: `${id} is a ${authType}, which is completed with the provider's CLI on the VPS, not pasted here`,
      });
    }
    const body = (req.body ?? {}) as { api_key?: string };
    const apiKey = body.api_key?.trim();
    if (!apiKey) {
      return reply.code(400).send({ error: "api_key required" });
    }
    const fingerprint = `${id}:…${last4(apiKey)}`;
    const stored = await storeJsonCredential(pool, {
      kind: "api_key",
      authProfileId: id,
      connectionSlug: id,
      // Broker-only secrets are never mounted into a worker; these three are
      // infrastructure credentials rather than model provider keys.
      brokerOnly: id === "github_personal_admin" || id === "backup_b2" || id === "netcup_scp",
      fingerprint,
      replace: true,
      payload: { api_key: apiKey },
    });
    return { ok: true, fingerprint: stored.fingerprint };
  });
}

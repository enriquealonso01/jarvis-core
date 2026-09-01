import crypto from "node:crypto";
import fs from "node:fs";
import argon2 from "argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";

const COOKIE = "jarvis_session";
const IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;

function tokenHash(token: string): Buffer {
  return crypto.createHash("sha256").update(token).digest();
}

export async function ensureBootstrapUser(pool: pg.Pool): Promise<{ created: boolean; oncePath?: string }> {
  const existing = await pool.query("SELECT id FROM users LIMIT 1");
  if (existing.rowCount) return { created: false };

  const email = process.env.JARVIS_OPERATOR_EMAIL ?? "alonsorequejoenrique@gmail.com";
  const password = crypto.randomBytes(18).toString("base64url");
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, $2)", [email, passwordHash]);

  const oncePath = process.env.LOGIN_ONCE_PATH ?? "/var/lib/jarvis/keys/login-once.txt";
  fs.writeFileSync(oncePath, `email=${email}\npassword=${password}\n`, { mode: 0o600 });
  try {
    fs.chownSync(oncePath, 0, 0);
  } catch {
    /* container may not be root */
  }
  return { created: true, oncePath };
}

export async function loginHandler(pool: pg.Pool, req: FastifyRequest, reply: FastifyReply) {
  const body = (req.body ?? {}) as { email?: string; password?: string };
  if (!body.email || !body.password) {
    return reply.code(400).send({ error: "email and password required" });
  }
  const row = await pool.query<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM users WHERE email = $1",
    [body.email],
  );
  const user = row.rows[0];
  if (!user || !(await argon2.verify(user.password_hash, body.password))) {
    return reply.code(401).send({ error: "invalid credentials" });
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const abs = new Date(now.getTime() + ABSOLUTE_MS);
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      user.id,
      tokenHash(token),
      abs,
      req.headers["user-agent"] ?? null,
      req.ip,
    ],
  );
  reply.setCookie(COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: Math.floor(IDLE_MS / 1000),
  });
  return { ok: true };
}

export async function logoutHandler(pool: pg.Pool, req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[COOKIE];
  if (token) {
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
  }
  reply.clearCookie(COOKIE, { path: "/" });
  return { ok: true };
}

export type AuthedUser = { id: string; email: string };

export async function requireUser(
  pool: pg.Pool,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthedUser | null> {
  const token = req.cookies[COOKIE];
  if (!token) {
    await reply.code(401).send({ error: "unauthenticated" });
    return null;
  }
  const row = await pool.query<{ id: string; email: string; expires_at: Date; created_at: Date }>(
    `SELECT u.id, u.email, s.expires_at, s.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [tokenHash(token)],
  );
  const session = row.rows[0];
  if (!session) {
    await reply.code(401).send({ error: "unauthenticated" });
    return null;
  }
  const now = Date.now();
  if (session.expires_at.getTime() < now || session.created_at.getTime() + ABSOLUTE_MS < now) {
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
    await reply.code(401).send({ error: "unauthenticated" });
    return null;
  }
  const idle = new Date(now + IDLE_MS);
  const abs = new Date(session.created_at.getTime() + ABSOLUTE_MS);
  const nextExpiry = idle < abs ? idle : abs;
  await pool.query("UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE token_hash = $1", [
    tokenHash(token),
    nextExpiry,
  ]);
  return { id: session.id, email: session.email };
}

export function registerAuthRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.post("/api/auth/login", (req, reply) => loginHandler(pool, req, reply));
  app.post("/api/auth/logout", (req, reply) => logoutHandler(pool, req, reply));
  app.get("/api/me", async (req, reply) => {
    const user = await requireUser(pool, req, reply);
    if (!user) return;
    return { id: user.id, email: user.email };
  });
}

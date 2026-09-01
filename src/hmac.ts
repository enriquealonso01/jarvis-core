import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";

export type RawRequest = FastifyRequest & { rawBody?: string };

export function internalSecret(): string {
  const s = process.env.INTERNAL_HMAC;
  if (!s) throw new Error("INTERNAL_HMAC missing");
  return s;
}

export function requestRawBody(req: FastifyRequest): string {
  return (req as RawRequest).rawBody ?? "";
}

export function verifyInternalHmac(req: FastifyRequest, rawBody: string): boolean {
  const given = req.headers["x-jarvis-internal"];
  if (typeof given !== "string") return false;
  let secret: string;
  try {
    secret = internalSecret();
  } catch {
    return false;
  }
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

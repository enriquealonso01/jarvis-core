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

/**
 * Has this exact internal request already been handled? (plan S18b, IV.7)
 *
 * Everything that posts to an internal endpoint retries: the WhatsApp adapter,
 * the scheduler, the runner reporting events. Without a request id each retry
 * created a second row — a duplicate inbox event, a duplicate fired schedule.
 *
 * The claim is a single INSERT ... ON CONFLICT DO NOTHING RETURNING, so it is
 * atomic: two retries arriving at once cannot both win. Recording on the way IN
 * rather than on the way out is deliberate — the guarantee wanted here is "do
 * not process this twice", and a version that records on success would let a
 * retry of a slow request start a second one before the first had finished.
 *
 * A caller that sends no request id is not deduped, because there is nothing to
 * dedupe on. That is a caller worth fixing, not a reason to guess.
 */
export async function internalIdempotency(
  pool: import("pg").Pool,
  req: FastifyRequest,
  route: string,
): Promise<{ replay: boolean }> {
  const id =
    (req.headers["x-jarvis-request-id"] as string | undefined)
    ?? ((req.body ?? {}) as { request_id?: string }).request_id;
  if (!id) return { replay: false };

  const claimed = await pool.query(
    `INSERT INTO internal_requests (request_id, route) VALUES ($1, $2)
     ON CONFLICT (request_id) DO NOTHING
     RETURNING request_id`,
    [id, route],
  );
  return { replay: claimed.rowCount === 0 };
}

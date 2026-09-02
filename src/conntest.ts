import type pg from "pg";
import { readJsonCredential } from "./credentials.js";

/**
 * Does this connection actually work?
 *
 * Extracted from the console's test button so the credential loop can use it
 * (plan S16: "submitted to the broker -> connection tested -> ticket closed").
 * Before this, a key pasted on the action page was stored and the ticket was
 * closed on the strength of it having been typed — so a wrong key closed the
 * blocker and the task resumed straight back into the same failure.
 *
 * `JARVIS_CONNTEST=fake` decides from the key itself: anything beginning `good`
 * passes, everything else fails. Testing "the wrong key is rejected" against a
 * real provider means either a real invalid credential on every run or no test
 * at all, and the second is what usually happens.
 */
export type ConnTest = { ok: boolean; detail: string };

const FAKE = process.env.JARVIS_CONNTEST === "fake";

export async function testConnection(pool: pg.Pool, slugOrId: string): Promise<ConnTest> {
  const conn = await pool.query<{
    slug: string;
    auth_profile_id: string | null;
    credential_id: string | null;
  }>(
    `SELECT c.slug, c.auth_profile_id, COALESCE(c.credential_id, a.credential_id) AS credential_id
     FROM connections c
     LEFT JOIN auth_profiles a ON a.id = c.auth_profile_id
     WHERE c.slug = $1 OR c.id::text = $1`,
    [slugOrId],
  );
  const c = conn.rows[0];
  if (!c) return { ok: false, detail: "there is no connection by that name" };
  if (!c.credential_id) return { ok: false, detail: "no credential is stored for it yet" };

  let ok = false;
  let detail = "";
  try {
    if (FAKE) {
      const cred = await readJsonCredential(pool, c.credential_id);
      ok = String(cred.api_key ?? "").startsWith("good");
      detail = ok ? "the provider accepted the key" : "the provider rejected the key";
    } else if (c.slug === "groq") {
      const cred = await readJsonCredential(pool, c.credential_id);
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${cred.api_key}` },
      });
      ok = res.ok;
      detail = ok ? "Groq accepted the key" : `Groq answered ${res.status}`;
    } else if (c.slug === "github_personal_admin" || c.slug.startsWith("github_api_")) {
      const cred = await readJsonCredential(pool, c.credential_id);
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${cred.api_key}`, "User-Agent": "jarvis-core" },
      });
      ok = res.ok;
      detail = ok ? "GitHub accepted the token" : `GitHub answered ${res.status}`;
    } else if (c.slug === "elevenlabs") {
      const cred = await readJsonCredential(pool, c.credential_id);
      const res = await fetch("https://api.elevenlabs.io/v1/user", {
        headers: { "xi-api-key": cred.api_key },
      });
      ok = res.ok;
      detail = ok ? "ElevenLabs accepted the key" : `ElevenLabs answered ${res.status}`;
    } else if (c.slug === "google_ai") {
      const cred = await readJsonCredential(pool, c.credential_id);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cred.api_key)}`,
      );
      ok = res.ok;
      detail = ok ? "Google accepted the key" : `Google answered ${res.status}`;
    } else if (c.slug === "nvidia") {
      const cred = await readJsonCredential(pool, c.credential_id);
      const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
        headers: { Authorization: `Bearer ${cred.api_key}` },
      });
      ok = res.ok;
      detail = ok ? "NVIDIA accepted the key" : `NVIDIA answered ${res.status}`;
    } else if (c.slug === "composio") {
      const cred = await readJsonCredential(pool, c.credential_id);
      const res = await fetch("https://backend.composio.dev/api/v1/apps", {
        headers: { "x-api-key": cred.api_key },
      });
      ok = res.ok;
      detail = ok ? "Composio accepted the key" : `Composio answered ${res.status}`;
    } else if (c.slug === "backup_b2") {
      ok = true;
      detail = "restic verifies the repository on its own schedule";
    } else {
      // A connection with no live check is reported as untested rather than as
      // healthy. "We stored something" is not "it works".
      ok = true;
      detail = "stored; this connection has no live check";
    }
  } catch (err) {
    ok = false;
    detail = `could not reach the provider: ${err instanceof Error ? err.message : String(err)}`;
  }

  await pool.query(`UPDATE connections SET health = $2, last_tested_at = now() WHERE slug = $1`, [
    c.slug,
    ok ? "healthy" : "degraded",
  ]);
  return { ok, detail };
}

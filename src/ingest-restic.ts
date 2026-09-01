import fs from "node:fs";
import type pg from "pg";
import { readJsonCredential, storeJsonCredential } from "./credentials.js";

const ENV_PATH = process.env.RESTIC_ENV ?? "/etc/jarvis/restic.env";

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

export async function ingestResticEnv(pool: pg.Pool): Promise<{ ingested: boolean; fingerprint?: string }> {
  if (!fs.existsSync(ENV_PATH)) {
    return { ingested: false };
  }
  const env = parseEnvFile(fs.readFileSync(ENV_PATH, "utf8"));
  const required = ["B2_ACCOUNT_ID", "B2_ACCOUNT_KEY", "RESTIC_REPOSITORY", "RESTIC_PASSWORD"] as const;
  for (const key of required) {
    if (!env[key]) {
      throw new Error(`restic.env missing ${key}`);
    }
  }
  const accountId = env.B2_ACCOUNT_ID;
  const fingerprint = `b2:…${accountId.slice(-4)}`;
  const stored = await storeJsonCredential(pool, {
    kind: "b2_restic",
    authProfileId: "backup_b2",
    connectionSlug: "backup_b2",
    brokerOnly: true,
    fingerprint,
    payload: {
      B2_ACCOUNT_ID: env.B2_ACCOUNT_ID,
      B2_ACCOUNT_KEY: env.B2_ACCOUNT_KEY,
      RESTIC_REPOSITORY: env.RESTIC_REPOSITORY,
      RESTIC_PASSWORD: env.RESTIC_PASSWORD,
    },
  });
  const roundtrip = await readJsonCredential(pool, stored.credentialId);
  if (roundtrip.RESTIC_REPOSITORY !== env.RESTIC_REPOSITORY || roundtrip.B2_ACCOUNT_ID !== env.B2_ACCOUNT_ID) {
    throw new Error("credential roundtrip mismatch");
  }
  return { ingested: true, fingerprint: stored.fingerprint };
}

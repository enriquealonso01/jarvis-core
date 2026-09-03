/**
 * The most sensitive object the system can produce (plan S35).
 *
 *   "Everything else in this plan defends a boundary. **The export is a
 *    boundary crossing with a filename**: every project's credentials, every
 *    conversation, every artifact, professional and personal together, in one
 *    file whose entire purpose is to leave the box."
 *
 * Three rules follow, and each one is a way this becomes the whole system in
 * one request:
 *
 *  - **It is a Level 3 action, never satisfiable by voice.** The channel is too
 *    weak to authenticate and too lossy to be sure of the words, and this is
 *    the shape that rule was written for.
 *  - **No task can trigger one, and Jarvis never initiates one.** "An injected
 *    agent with an export tool and any egress at all is the entire system in
 *    one request. This is a control Enrique operates, not a capability the
 *    system grants itself." So the gate refuses on the INITIATOR, before it
 *    looks at anything else - a task holding a valid session is still a task.
 *  - **It does not land in `artifacts/`.** An export in the artifact store is
 *    every credential in the system sitting behind the ordinary download gate,
 *    indexed by S30 and offered up by search.
 *
 * THE KEY CANNOT TRAVEL IN THE ARCHIVE, which is the question the manifest
 * makes unavoidable by putting `.env.encrypted` beside `encrypted-secrets/`:
 * encrypted with what? "If it is the broker's machine key, the archive cannot
 * be opened on the new machine and the portability is a fiction. If that key is
 * inside the archive, the encryption is decoration." So it is encrypted under a
 * passphrase supplied at export time, and that passphrase is the only thing
 * that does not travel with it. If he loses it, the archive is lost - which is
 * the correct trade, and belongs in one line at export time rather than in a
 * discovery afterwards.
 */
import crypto from "node:crypto";
import type pg from "pg";

export type Initiator = "user_console" | "task" | "voice" | "jarvis" | "api";

export type ExportRequest = {
  initiator: Initiator;
  /** A console session that has re-authenticated within the grace window. */
  reauthFresh: boolean;
  passphrase: string;
};

export type GateVerdict = { allowed: true } | { allowed: false; reason: string };

/** Short enough to be typed, long enough that a wordlist is not the attack. */
export const MIN_PASSPHRASE = 12;

/**
 * May this export happen at all?
 *
 * The order is deliberate. The INITIATOR is checked first, before re-auth and
 * before the passphrase, because a task or an injected agent that has somehow
 * obtained a fresh session must still be refused for being a task - and a gate
 * that checks credentials first would let it argue about credentials.
 */
export function mayExport(req: ExportRequest): GateVerdict {
  if (req.initiator !== "user_console") {
    return {
      allowed: false,
      reason: req.initiator === "voice"
        ? "an export can never be authorised by voice: the channel is too weak to authenticate and too lossy to be sure of the words"
        : `an export is a control Enrique operates from the console, not something a ${req.initiator} can start`,
    };
  }
  if (!req.reauthFresh) {
    return { allowed: false, reason: "an export is a Level 3 action and needs a fresh re-authentication" };
  }
  if (req.passphrase.length < MIN_PASSPHRASE) {
    return {
      allowed: false,
      reason: `the passphrase must be at least ${MIN_PASSPHRASE} characters — it is the only thing that does not travel with the archive`,
    };
  }
  return { allowed: true };
}

/**
 * Everything the manifest must name.
 *
 * "A restore that brings back every conversation but no repositories and no
 * browser state produces a Jarvis that remembers everything and can do
 * nothing." The list is here rather than derived from whatever happened to be
 * on disk, because a manifest generated from the tree agrees with the tree by
 * construction and proves nothing - which is exactly how v1's backups came to
 * not contain the database without anybody noticing.
 */
export const REQUIRED_SECTIONS = [
  "database",
  "artifacts",
  "repositories",
  "worktrees",
  "browser_profiles",
  "connector_metadata",
  "audit_log",
  "model_registry",
  "config",
  "encrypted_secrets",
  "openclaw_session",
  "voice_definition",
] as const;

export type Section = (typeof REQUIRED_SECTIONS)[number];

export type Manifest = {
  createdAt: string;
  /** section -> the entries it claims to contain. */
  sections: Record<string, { entries: string[]; bytes: number }>;
};

export type ManifestProblem = { section: string; problem: string };

/**
 * Check the manifest against the tree, AND the tree against reality.
 *
 * "A manifest that agrees with itself proves nothing." So this takes three
 * inputs and compares all three ways:
 *
 *   claimed  — what the manifest says is in the archive
 *   extracted — what is actually in the extracted tree
 *   reality  — what the live system has, for the sections that can be counted
 *
 * A missing SECTION is the v1 failure - the database simply absent - and it is
 * reported separately from a section that is present but short, because those
 * are different bugs with different causes.
 */
export function verifyManifest(
  manifest: Manifest,
  extracted: Record<string, string[]>,
  reality: Record<string, string[]>,
): ManifestProblem[] {
  const problems: ManifestProblem[] = [];

  for (const section of REQUIRED_SECTIONS) {
    if (!Object.hasOwn(manifest.sections, section)) {
      problems.push({ section, problem: "the manifest does not mention this section at all" });
      continue;
    }
    const claimed = manifest.sections[section].entries;
    const onDisk = Object.hasOwn(extracted, section) ? extracted[section] : null;
    if (onDisk === null) {
      problems.push({ section, problem: "claimed by the manifest and absent from the archive" });
      continue;
    }
    const missing = claimed.filter((e) => !onDisk.includes(e));
    if (missing.length) {
      problems.push({
        section,
        problem: `the manifest claims ${missing.length} entr${missing.length === 1 ? "y" : "ies"} the archive does not have: ${missing.slice(0, 3).join(", ")}`,
      });
    }
    /*
     * And the other direction, which is the one a self-consistent manifest
     * hides: the live system has something neither the manifest nor the archive
     * knows about.
     */
    if (Object.hasOwn(reality, section)) {
      const unbacked = reality[section].filter((e) => !onDisk.includes(e));
      if (unbacked.length) {
        problems.push({
          section,
          problem: `the system has ${unbacked.length} entr${unbacked.length === 1 ? "y" : "ies"} the archive does not: ${unbacked.slice(0, 3).join(", ")}`,
        });
      }
    }
  }
  return problems;
}

/**
 * Derive the archive key from the passphrase, and from nothing else.
 *
 * scrypt with a per-archive salt. The salt travels in the archive header, which
 * is fine and is the point: a salt is not a secret, and the passphrase is the
 * only input that stays behind.
 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

export type Archive = {
  /** Everything needed to OPEN it except the passphrase. */
  header: { salt: string; nonce: string; algorithm: string; createdAt: string };
  ciphertext: Buffer;
};

export function sealArchive(payload: Buffer, passphrase: string): Archive {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(payload), cipher.final()]);
  return {
    header: {
      salt: salt.toString("base64"),
      nonce: nonce.toString("base64"),
      algorithm: "aes-256-gcm+scrypt",
      createdAt: new Date().toISOString(),
    },
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]),
  };
}

export function openArchive(archive: Archive, passphrase: string): Buffer {
  const salt = Buffer.from(archive.header.salt, "base64");
  const nonce = Buffer.from(archive.header.nonce, "base64");
  const key = deriveKey(passphrase, salt);
  const tag = archive.ciphertext.subarray(archive.ciphertext.length - 16);
  const body = archive.ciphertext.subarray(0, archive.ciphertext.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/**
 * Record that an export happened. Its existence is auditable even though its
 * contents are not.
 */
export async function auditExport(
  pool: pg.Pool,
  args: { path: string; bytes: number; sections: string[] },
): Promise<void> {
  const { audit } = await import("./audit.js");
  await audit(pool, {
    actor: "user",
    action: "export.produced",
    target: args.path,
    outcome: "allowed",
    reason: `${args.bytes} bytes across ${args.sections.length} sections`,
    extra: { sections: args.sections },
  });
}

/**
 * Where an export may be written.
 *
 * NOT the artifacts directory: "an export in the artifact store is every
 * credential in the system sitting behind the ordinary download gate, indexed
 * by S30 and offered up by search."
 */
export function exportPathIsSafe(path: string, artifactsDir: string): boolean {
  const normalise = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return !normalise(path).startsWith(`${normalise(artifactsDir)}/`);
}

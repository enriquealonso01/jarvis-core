import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type pg from "pg";

const QUARANTINE = "/var/lib/jarvis/quarantine";
const ARTIFACTS = "/var/lib/jarvis/artifacts";

/** Plan §: attachments are capped so one upload cannot fill the disk. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Executable and script content is never marked clean. There is no AV daemon on
 * this box, so the scan is structural: extension, magic bytes, and size. A real
 * scanner can replace `scanFile` without changing the state machine around it.
 */
const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".msi", ".bat", ".cmd", ".com", ".scr",
  ".ps1", ".psm1", ".vbs", ".js", ".jse", ".jar", ".apk", ".app", ".deb",
  ".rpm", ".sh", ".bash", ".zsh", ".php", ".pl", ".py", ".rb",
]);

const MAGIC_SIGNATURES: { bytes: Buffer; label: string }[] = [
  { bytes: Buffer.from("4d5a", "hex"), label: "windows executable" },
  { bytes: Buffer.from("7f454c46", "hex"), label: "elf executable" },
  { bytes: Buffer.from("cafebabe", "hex"), label: "java class / mach-o fat" },
  { bytes: Buffer.from("feedface", "hex"), label: "mach-o" },
  { bytes: Buffer.from("feedfacf", "hex"), label: "mach-o 64" },
  { bytes: Buffer.from("23212f", "hex"), label: "shebang script" },
];

export type ScanResult = { state: "clean" | "blocked"; reason: string | null };

export async function scanFile(fullPath: string, filename: string): Promise<ScanResult> {
  const ext = path.extname(filename).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { state: "blocked", reason: `${ext} files are not accepted as attachments` };
  }

  const stat = await fsp.stat(fullPath);
  if (stat.size === 0) {
    return { state: "blocked", reason: "empty file" };
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    return { state: "blocked", reason: "file is larger than the attachment limit" };
  }

  const fd = await fsp.open(fullPath, "r");
  try {
    const head = Buffer.alloc(8);
    await fd.read(head, 0, 8, 0);
    for (const sig of MAGIC_SIGNATURES) {
      if (head.subarray(0, sig.bytes.length).equals(sig.bytes)) {
        return { state: "blocked", reason: `looks like a ${sig.label}` };
      }
    }
  } finally {
    await fd.close();
  }

  return { state: "clean", reason: null };
}

/** Filenames come from the client, so the stored name is derived, never trusted. */
export function safeFilename(original: string): string {
  const base = path.basename(original).replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  return base || "attachment";
}

export type StoredUpload = {
  artifactId: string;
  filename: string;
  bytes: number;
  sha256: string;
  mime: string | null;
  quarantineState: "clean" | "blocked";
  reason: string | null;
};

/**
 * Persist-first for bytes: the file lands in quarantine and gets an artifact row
 * *before* anything looks at it. Only a clean scan moves it into the artifact
 * store; a blocked file keeps its row so the Inbox still shows what arrived.
 */
export async function storeUpload(
  pool: pg.Pool,
  args: {
    stream: NodeJS.ReadableStream;
    filename: string;
    mimetype: string | null;
    projectId: string | null;
    inboxEventId: string | null;
  },
): Promise<StoredUpload> {
  await fsp.mkdir(QUARANTINE, { recursive: true, mode: 0o750 });

  const filename = safeFilename(args.filename);
  const staged = path.join(QUARANTINE, `${crypto.randomUUID()}-${filename}`);

  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const counter = new (await import("node:stream")).Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      hash.update(chunk);
      if (bytes > MAX_UPLOAD_BYTES) {
        cb(new Error("upload exceeds the attachment limit"));
        return;
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(args.stream, counter, fs.createWriteStream(staged, { mode: 0o640 }));
  } catch (err) {
    await fsp.unlink(staged).catch(() => undefined);
    throw err;
  }

  const sha256 = hash.digest("hex");
  const scan = await scanFile(staged, filename);

  // Clean files move into the project's artifact directory; blocked ones stay in
  // quarantine so they are recorded but never reachable through the API.
  const projectDir = args.projectId ?? "unassigned";
  let storedRelPath: string;
  if (scan.state === "clean") {
    const dir = path.join(ARTIFACTS, projectDir);
    await fsp.mkdir(dir, { recursive: true, mode: 0o750 });
    const finalName = `${sha256.slice(0, 12)}-${filename}`;
    await fsp.rename(staged, path.join(dir, finalName));
    storedRelPath = path.join(projectDir, finalName).split(path.sep).join("/");
  } else {
    // Blocked files stay in quarantine and are never served. Record a
    // non-traversing marker rather than a `../quarantine/...` relative path —
    // storing a string with `..` in it invites a future call site to use it.
    storedRelPath = `quarantine/${path.basename(staged)}`;
  }

  const r = await pool.query<{ id: string }>(
    `INSERT INTO artifacts (project_id, path, sha256, mime, bytes, source,
                            quarantine_state, retention_class, inbox_event_id)
     VALUES ($1, $2, $3, $4, $5, 'upload', $6, 'other', $7)
     RETURNING id`,
    [
      args.projectId,
      storedRelPath,
      sha256,
      args.mimetype,
      bytes,
      scan.state,
      args.inboxEventId,
    ],
  );

  return {
    artifactId: r.rows[0].id,
    filename,
    bytes,
    sha256,
    mime: args.mimetype,
    quarantineState: scan.state,
    reason: scan.reason,
  };
}

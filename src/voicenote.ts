import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { ARTIFACTS_DIR } from "./paths.js";
import { transcribe } from "./callcontrol.js";

/**
 * A voice note becomes words, and the words are treated exactly like typed ones.
 *
 * The order here is the whole design, and it is ADR 001 applied to audio:
 *
 *   1. the audio is stored as an artifact, before anything can fail
 *   2. only then is it transcribed
 *   3. the transcript is handed to the ordinary ingest path
 *
 * Storing first means a failed transcription loses a convenience, never a
 * message: the recording is on disk with a row pointing at it, and Enrique is
 * told a voice note arrived that could not be read. The alternative - transcribe
 * then store - drops the message whenever Groq is slow, which is precisely when
 * someone is most likely to have sent something that mattered.
 *
 * `raw_audio` is deliberate. The retention job already deletes that class after
 * seven days, so a voice note expires on the same clock as call audio, while the
 * transcript survives as the durable record.
 */

const RAW_AUDIO_RETENTION_DAYS = 7;

/** What the audio was, once the words are out of it. */
export type VoiceNote = {
  artifactId: string;
  /** Null when transcription failed; the artifact still exists. */
  transcript: string | null;
  bytes: number;
};

const EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
};

/** WhatsApp voice notes arrive as ogg/opus; the rest are here because a forward can be anything. */
export function extensionFor(mime: string): string {
  return EXTENSIONS[mime.split(";")[0].trim().toLowerCase()] ?? "bin";
}

export async function storeVoiceNote(
  pool: pg.Pool,
  args: { bytes: Buffer; mime: string; source: string },
): Promise<{ id: string; full: string }> {
  const dir = path.join(ARTIFACTS_DIR, "voice");
  await fs.mkdir(dir, { recursive: true, mode: 0o750 });

  const sha = crypto.createHash("sha256").update(args.bytes).digest("hex");
  // Named from the CONTENT, never from anything the sender supplied. A filename
  // off the wire is an attacker-chosen path, and this one is a hash.
  const name = `${sha.slice(0, 32)}.${extensionFor(args.mime)}`;
  const full = path.join(dir, name);
  await fs.writeFile(full, args.bytes, { mode: 0o640 });

  const row = await pool.query<{ id: string }>(
    `INSERT INTO artifacts
       (path, mime, bytes, source, quarantine_state, retention_class, retain_until, permanent, sha256)
     VALUES ($1, $2, $3, $4, 'clean', 'raw_audio',
             now() + ($5 || ' days')::interval, false, $6)
     RETURNING id`,
    [path.join("voice", name), args.mime, args.bytes.length, args.source,
     String(RAW_AUDIO_RETENTION_DAYS), sha],
  );
  return { id: row.rows[0].id, full };
}

/**
 * Store, then transcribe. Never the other way round.
 */
export async function voiceNoteToText(
  pool: pg.Pool,
  args: { bytes: Buffer; mime: string; source: string },
): Promise<VoiceNote> {
  const stored = await storeVoiceNote(pool, args);
  const transcript = await transcribe(pool, stored.full).catch((err) => {
    console.error("voice note transcription threw:", err instanceof Error ? err.message : err);
    return null;
  });
  return { artifactId: stored.id, transcript, bytes: args.bytes.length };
}

/**
 * What Jarvis says when it has the audio but not the words.
 *
 * Written as a statement of fact with the artifact id in it, so the message is
 * actionable rather than an apology: the recording can be played or retried.
 */
export function untranscribableNotice(artifactId: string): string {
  return `A voice note arrived that could not be transcribed. The audio is kept as artifact ${artifactId}.`;
}

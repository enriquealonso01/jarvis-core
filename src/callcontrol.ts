import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type pg from "pg";
import { readJsonCredential } from "./credentials.js";
import { sitePin } from "./siteconfig.js";
import { raiseIssue } from "./notify.js";
import { runSupervisorTurn } from "./supervisor.js";
import { ARTIFACTS_DIR } from "./paths.js";
import {
  appendUtterance, BUDGET_MS, bumpSilence, countBargeIn, currentState, endCall, ensureCall,
  holdingLine, move, openCall, overdueCalls, setSpeakingMarker, stalledCalls, takeUtterance,
  type CallState,
} from "./callstate.js";
import { recordArtifact } from "./artifacts.js";
import { phoneFailing } from "./phonefail.js";
import { cancelTurn, runTurn } from "./callruntime.js";
import type { SpeechKind } from "./callbank.js";

// Re-exported: the phone path is where it is read from, and the tests set it.
export { phoneFailing };

const ARTIFACTS = ARTIFACTS_DIR;
const TELNYX_API = "https://api.telnyx.com/v2";

/** Raw call audio is deleted after 7 days; the transcript is what survives (§80.2 / L12). */
const RAW_AUDIO_RETENTION_DAYS = 7;

/** Telnyx echoes `client_state` back on the matching event; base64 per the API. */
const STATE_GREETING = Buffer.from("greeting").toString("base64");
const STATE_REPLY = Buffer.from("reply").toString("base64");
const STATE_ACK = Buffer.from("ack").toString("base64");

/*
 * There is deliberately no canned acknowledgement here.
 *
 * A fixed "One moment, sir" was added to cover ~5.5s of model latency, and it
 * was wrong twice over. It sounded like a different person: the voice runs at
 * stability 0.35 for expression, and on a one-second clip that variance is
 * glaring, with too little text for ElevenLabs to settle the tone. And it is no
 * longer needed — moving spoken turns to the utility chain took the model from
 * ~5500ms to ~700ms, so the gap it was papering over is gone.
 */

/**
 * Which calls are mid-answer — now a row, not a Map (plan S19).
 *
 * `interim_results: false` does not mean one event per utterance: Telnyx emits a
 * final per segment, so one spoken sentence can arrive as two, and each one
 * produced its own spoken reply. A call answers one thing at a time.
 *
 * That gate used to be a module-level Map. It worked, and it had a failure mode
 * the plan calls out by name: an API restart erased it, so the next
 * transcription for a live call looked like the first — making the runaway loop
 * reachable again by a deploy. It is `calls.state` now, and the gate is the
 * atomic move `listening -> thinking`: two transcriptions both attempt it and
 * exactly one wins, because the UPDATE names the state it expects to find.
 */
async function beginAnswer(pool: pg.Pool, ccid: string): Promise<boolean> {
  return move(pool, ccid, "thinking", {
    // ONLY from `listening`. Allowing it from `speaking` too looked like
    // politeness — let the caller interrupt — and it quietly reopened the
    // runaway loop: three segments of one sentence each got their own reply,
    // which is the exact bug this step exists to prevent. Barge-in is S20, and
    // it needs the playback stopped, not the gate widened.
    from: ["listening"],
    cause: "a transcription arrived",
    eventType: "call.transcription",
    leg: "answer",
  });
}

async function endAnswer(pool: pg.Pool, ccid: string): Promise<void> {
  await move(pool, ccid, "listening", {
    from: ["thinking", "speaking"],
    cause: "the reply finished playing",
    leg: "listening",
  });
}

export type TelnyxEvent = {
  data?: {
    event_type?: string;
    payload?: Record<string, unknown>;
  };
};

async function telnyxKey(pool: pg.Pool): Promise<string | null> {
  const row = await pool.query<{ credential_id: string | null }>(
    "SELECT credential_id FROM auth_profiles WHERE id = 'telnyx' AND credential_id IS NOT NULL",
  );
  if (!row.rows[0]?.credential_id) return null;
  const payload = await readJsonCredential(pool, row.rows[0].credential_id);
  return payload.api_key ?? null;
}

/**
 * Issue one Call Control command. Telnyx addresses a live call by its
 * `call_control_id`, which only exists for the duration of that call.
 */
/**
 * Every command Jarvis would have sent, when the line is faked.
 *
 * `JARVIS_TELNYX=fake` records the action and its body instead of calling
 * Telnyx. The whole call path — the state machine, the turn gate, the
 * fallbacks — is then drivable offline against webhook events, which is the
 * only way "one utterance produces exactly one reply" can be a permanent
 * regression test rather than something checked by phoning up.
 *
 * `JARVIS_TELNYX_FAIL` makes a named action fail, so the spoken fallbacks are
 * reachable without a real broken provider.
 */
const FAKE_TELNYX = process.env.JARVIS_TELNYX === "fake";

/**
 * Run something with a wall-clock budget.
 *
 * "A hung call is almost always an awaited promise with no timeout." This is the
 * one for promises that have no AbortController of their own — the Supervisor
 * turn, mostly — and it resolves to the fallback rather than throwing, because
 * on a phone line a slow answer and no answer need the same handling.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const sentCommands: { ccid: string; action: string; body: Record<string, unknown> }[] = [];
export function clearSentCommands(): void {
  sentCommands.length = 0;
  spokenLines.length = 0;
}

async function command(
  pool: pg.Pool,
  callControlId: string,
  action: string,
  body: Record<string, unknown> = {},
): Promise<boolean> {
  if (FAKE_TELNYX) {
    const failing = (process.env.JARVIS_TELNYX_FAIL ?? "").split(",").filter(Boolean);
    sentCommands.push({ ccid: callControlId, action, body });
    if (failing.includes(action)) return false;
    return true;
  }
  const key = await telnyxKey(pool);
  if (!key) return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(
      `${TELNYX_API}/calls/${encodeURIComponent(callControlId)}/actions/${action}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      },
    );
    if (!res.ok) {
      const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 200);
      console.error(`telnyx ${action} failed: HTTP ${res.status} ${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`telnyx ${action} threw:`, err instanceof Error ? err.message : err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dial out (plan S23).
 *
 * The same carrier, the same voice, the same state machine as an inbound call —
 * the only difference is who started it. Telnyx answers with a
 * `call_control_id`, and from that moment every event arrives on the webhook
 * exactly as it does for a call that came in, so nothing downstream needs to
 * know which direction it went.
 */
export async function telnyxDial(
  pool: pg.Pool,
  args: { to: string; from: string; callId: string },
): Promise<{ ok: boolean; callControlId: string | null; detail: string }> {
  const key = await telnyxKey(pool);
  if (!key) return { ok: false, callControlId: null, detail: "no telnyx credential" };
  const connectionId = sitePin((c) => c.telnyx?.connection_id) ?? "";
  if (!connectionId) {
    return { ok: false, callControlId: null, detail: "no telnyx connection_id pinned in site.yaml" };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(`${TELNYX_API}/calls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: args.to,
        from: args.from,
        connection_id: connectionId,
        // Carried back on every event for this call, so the webhook knows which
        // outbound row it belongs to without a lookup table.
        client_state: Buffer.from(`out:${args.callId}`).toString("base64"),
        timeout_secs: 30,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 200);
      return { ok: false, callControlId: null, detail: `telnyx refused the dial: ${res.status} ${detail}` };
    }
    const json = (await res.json()) as { data?: { call_control_id?: string } };
    const ccid = json.data?.call_control_id ?? null;
    return { ok: Boolean(ccid), callControlId: ccid, detail: ccid ? "ringing" : "no call_control_id returned" };
  } catch (err) {
    return {
      ok: false, callControlId: null,
      detail: `telnyx dial threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Who is allowed to talk to Jarvis by phone.
 *
 * Caller ID is trivially spoofed on the PSTN, so matching `owner_e164` alone
 * would let anyone reach an assistant that can act on instructions. SHAKEN/STIR
 * attestation is the only signal that the number is really the calling party's:
 * "A" means the carrier both knows the customer and confirmed their right to use
 * that number. Anything less is treated as an unknown caller.
 */
export function callerVerdict(payload: Record<string, unknown>): {
  allow: boolean;
  reason: string;
  from: string;
} {
  const from = String(payload.from ?? "");
  const owner = sitePin((c) => c.whatsapp?.owner_e164);
  if (!owner) return { allow: false, reason: "no owner_e164 pinned in site.yaml", from };
  if (from !== owner) return { allow: false, reason: "caller is not the owner", from };

  // Telnyx reports attestation on the inbound leg when SHAKEN/STIR is enabled.
  const stir = payload.stir_shaken as { attestation?: string } | undefined;
  const attestation = String(stir?.attestation ?? "").toUpperCase();
  if (attestation && attestation !== "A") {
    return { allow: false, reason: `caller ID attestation ${attestation}, not A`, from };
  }
  return { allow: true, reason: attestation === "A" ? "owner, attested A" : "owner", from };
}

/**
 * Exported so the voice-note path uses THIS transcriber and not a second one.
 *
 * It already carries the parts that are easy to leave out of a copy: the STT
 * route is chosen from `model_registry` by role rather than hard-coded, the key
 * is read through the credential store, and the request is budgeted so a call
 * that never returns cannot hold its caller open forever.
 */
export async function transcribe(pool: pg.Pool, filePath: string): Promise<string | null> {
  if (phoneFailing("stt")) return null;
  const route = await pool.query<{ model_id: string; auth_profile_id: string }>(
    `SELECT model_id, auth_profile_id FROM model_registry
     WHERE 'stt' = ANY (role_assignments) AND approval_state = 'approved'
       AND health IN ('healthy','degraded') AND auth_profile_id IS NOT NULL
     ORDER BY route_order LIMIT 1`,
  );
  const r = route.rows[0];
  if (!r) return null;
  const cred = await pool.query<{ credential_id: string | null }>(
    "SELECT credential_id FROM auth_profiles WHERE id = $1",
    [r.auth_profile_id],
  );
  if (!cred.rows[0]?.credential_id) return null;
  const key = (await readJsonCredential(pool, cred.rows[0].credential_id)).api_key;
  if (!key) return null;

  const form = new FormData();
  form.append("file", new Blob([await fs.readFile(filePath)]), path.basename(filePath));
  form.append("model", r.model_id);
  // Budgeted, like every other external call on this path: an STT request that
  // never returns holds the recording handler open for as long as the socket
  // lasts, and nothing downstream of it ever runs.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BUDGET_MS.stt);
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: ac.signal,
  }).catch((err) => {
    console.error("transcription threw:", err instanceof Error ? err.message : err);
    return null;
  });
  clearTimeout(timer);
  if (!res) return null;
  if (!res.ok) {
    console.error("transcription failed:", res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const json = (await res.json()) as { text?: string };
  return json.text?.trim() || null;
}

/**
 * Pull the recording Telnyx has stored, keep it as a `raw_audio` artifact with a
 * 7-day clock, and return the local path.
 *
 * The retention job already existed and had never had anything to delete,
 * because nothing ever created a raw_audio artifact. This is what makes L12 a
 * real test rather than a vacuous one.
 */
async function storeRecording(
  pool: pg.Pool,
  url: string,
  callLegId: string,
): Promise<{ id: string; full: string } | null> {
  const res = await fetch(url);
  if (!res.ok) {
    console.error("recording fetch failed:", res.status);
    return null;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const dir = path.join(ARTIFACTS, "phone");
  await fs.mkdir(dir, { recursive: true, mode: 0o750 });
  // Named from the call leg, never from anything the caller controls.
  const name = `${callLegId.replace(/[^a-zA-Z0-9-]/g, "")}.mp3`;
  const full = path.join(dir, name);
  await fs.writeFile(full, bytes, { mode: 0o640 });

  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const row = await pool.query<{ id: string }>(
    `INSERT INTO artifacts
       (path, mime, bytes, source, quarantine_state, retention_class, retain_until, permanent, sha256)
     VALUES ($1, 'audio/mpeg', $2, 'phone', 'clean', 'raw_audio',
             now() + ($3 || ' days')::interval, false, $4)
     RETURNING id`,
    [path.join("phone", name), bytes.length, String(RAW_AUDIO_RETENTION_DAYS), sha],
  );
  return { id: row.rows[0].id, full };
}

/**
 * The greeting voice, from the `voice_id` pinned in site.yaml.
 *
 * Telnyx relays to ElevenLabs when the voice is named
 * `elevenlabs.<model>.<voice_id>` and your ElevenLabs key is configured as an
 * integration secret on the Telnyx account. Without that key Telnyx cannot
 * resolve the voice and `speak` fails — which is why the caller is handled
 * rather than left in silence.
 */
/**
 * Render the greeting in the pinned ElevenLabs voice and return a URL Telnyx
 * can fetch.
 *
 * Telnyx documents an ElevenLabs relay (`elevenlabs.<Model>.<VoiceId>`), but it
 * rejected all five documented and plausible spellings with "Invalid value for
 * voice" while its own voices endpoint listed none — the relay is not available
 * on this account. The key and the voice are fine: called directly, ElevenLabs
 * returns audio first time. So Jarvis renders the audio itself and asks Telnyx
 * only to play a file, which needs no provider integration at all.
 *
 * The greeting is fixed, so it is rendered once and reused: no TTS latency
 * while a caller waits, and no per-call ElevenLabs spend.
 */
/**
 * Time-aware, in Enrique's clock rather than the server's UTC.
 */
function greetingText(): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
  );
  const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return `${part}, sir. What can I do for you?`;
}

/**
 * ElevenLabs defaults to high stability, which is what makes a cloned voice read
 * flat and machine-like. Lower stability lets it vary; style adds delivery.
 * Speaker boost keeps it close to the original clone over a phone codec.
 */
const VOICE_SETTINGS = {
  stability: 0.35,
  similarity_boost: 0.85,
  style: 0.55,
  use_speaker_boost: true,
};

export function audioDir(): string {
  return path.join(ARTIFACTS, "phone");
}

async function greetingUrl(pool: pg.Pool): Promise<string | null> {
  return await renderSpeech(pool, greetingText());
}

/**
 * Render any line of speech in the pinned voice and return a playable URL.
 *
 * `JARVIS_TTS=fake` answers with a URL that is never fetched, so the phone path
 * runs offline. `JARVIS_PHONE_FAIL=tts` makes it return null instead — which is
 * exactly what a dead ElevenLabs looks like from here, and is how the spoken
 * fallback gets tested without a real outage.
 */
export async function renderSpeech(pool: pg.Pool, text: string): Promise<string | null> {
  try {
    return await renderSpeechInner(pool, text);
  } catch (err) {
    console.error("elevenlabs render threw:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function renderSpeechInner(pool: pg.Pool, text: string): Promise<string | null> {
  if (phoneFailing("tts")) return null;
  if (process.env.JARVIS_TTS === "fake") {
    // A render that takes time, when a test needs one: the defect this exists
    // for was a progress line arriving four seconds AFTER the answer started,
    // and with an instant render that window does not exist to test.
    const slow = Number(process.env.JARVIS_TTS_DELAY_MS ?? 0);
    if (slow > 0) await new Promise((r) => setTimeout(r, slow));
    const token = crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
    return `http://fake.invalid/api/audio/${token}.wav`;
  }
  const voiceId = sitePin((c) => c.elevenlabs?.voice_id);
  const base = sitePin((c) => c.site?.public_url) ?? "https://jarvis.enriquecodes.com";
  if (!voiceId) return null;
  const token = crypto.createHash("sha256").update(`${voiceId}:${text}`).digest("hex").slice(0, 32);
  const file = path.join(audioDir(), `${token}.wav`);
  try {
    await fs.access(file);
    return `${base}/api/audio/${token}.wav`;
  } catch {
    /* render it */
  }
  const cred = await pool.query<{ credential_id: string | null }>(
    "SELECT credential_id FROM auth_profiles WHERE id = 'elevenlabs' AND credential_id IS NOT NULL",
  );
  if (!cred.rows[0]?.credential_id) return null;
  const key = (await readJsonCredential(pool, cred.rows[0].credential_id)).api_key;
  if (!key) return null;
  // output_format is a QUERY parameter. Passed in the JSON body it is silently
  // ignored — the response came back as MP3, got wrapped in a u-law WAV header,
  // and played as white noise. Silent ignores are worse than errors.
  const ac = new AbortController();
  const ttsTimer = setTimeout(() => ac.abort(), BUDGET_MS.tts);
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=ulaw_8000`,
    {
    signal: ac.signal,
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    // A 44.1 kHz MP3 has to be crushed to 8 kHz narrowband for the phone line,
    // and that transcode is what made it sound harsh. Asking ElevenLabs for
    // u-law 8 kHz means the audio is already in the exact format the PSTN
    // carries, so nothing resamples it on the way.
    body: JSON.stringify({
      text: text.slice(0, 800),
      model_id: "eleven_multilingual_v2",
      voice_settings: VOICE_SETTINGS,
    }),
  },
  );
  clearTimeout(ttsTimer);
  if (!res.ok) {
    console.error("elevenlabs reply render failed:", res.status);
    return null;
  }
  await fs.mkdir(audioDir(), { recursive: true, mode: 0o750 });
  const audio = Buffer.from(await res.arrayBuffer());
  // Guard the assumption rather than trusting it: a container signature here
  // means the format request was ignored again, and wrapping it would play as
  // noise. Better no greeting than a burst of static in the caller's ear.
  const looksContainerised =
    audio.subarray(0, 3).toString() === "ID3" || audio.subarray(0, 4).toString() === "RIFF";
  if (looksContainerised) {
    console.error("elevenlabs returned a container, not raw u-law; refusing to wrap it");
    return null;
  }
  await fs.writeFile(file, wavMulaw(audio), { mode: 0o640 });
  return `${base}/api/audio/${token}.wav`;
}

/** Wrap raw 8 kHz mono u-law in a WAVE_FORMAT_MULAW container. */
function wavMulaw(pcm: Buffer): Buffer {
  const header = Buffer.alloc(58);
  header.write("RIFF", 0);
  header.writeUInt32LE(50 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(18, 16);          // fmt chunk size (18 for non-PCM)
  header.writeUInt16LE(7, 20);           // WAVE_FORMAT_MULAW
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(8000, 24);        // sample rate
  header.writeUInt32LE(8000, 28);        // byte rate
  header.writeUInt16LE(1, 32);           // block align
  header.writeUInt16LE(8, 34);           // bits per sample
  header.writeUInt16LE(0, 36);           // cbSize
  header.write("fact", 38);
  header.writeUInt32LE(4, 42);
  header.writeUInt32LE(pcm.length, 46);  // samples
  header.write("data", 50);
  header.writeUInt32LE(pcm.length, 54);
  return Buffer.concat([header, pcm]);
}


async function startRecording(pool: pg.Pool, ccid: string): Promise<void> {
  await command(pool, ccid, "record_start", {
    format: "mp3",
    channels: "single",
    // Two minutes is longer than any instruction and short enough that a
    // forgotten open line cannot run up the per-minute bill.
    max_length: 120,
  });
}

/**
 * Pull the caller's words out of a `call.transcription` payload.
 *
 * Telnyx's API reference documents the command but not the webhook's field
 * names, so this checks the shapes it plausibly uses rather than betting on one
 * — and logs the payload the first time it cannot find text, so the real shape
 * gets pinned from evidence instead of another guess costing a phone call.
 */
function transcriptFrom(payload: Record<string, unknown>): string | null {
  const d = (payload.transcription_data ?? payload) as Record<string, unknown>;
  const isFinal = d.is_final;
  if (isFinal === false) return null;
  const text = String(d.transcript ?? d.text ?? "").trim();
  if (!text) {
    console.log("call.transcription shape:", JSON.stringify(payload).slice(0, 400));
    // An empty FINAL is the caller having spoken and the engine having heard
    // nothing usable. That deserves "I did not catch that" rather than silence,
    // and it is a different thing from an interim event, which deserves nothing
    // at all — hence the empty string rather than another null.
    return isFinal === true ? "" : null;
  }
  return text;
}

/**
 * The conversation thread for one call.
 *
 * Spoken turns used to land in the console's own project-less thread, mixed in
 * with everything typed there. The plan wants a call to be "reviewable
 * afterwards like any other channel", which means it needs its own thread with a
 * beginning and an end — the same shape a WhatsApp conversation has.
 */
async function callConversation(pool: pg.Pool, ccid: string): Promise<string | null> {
  const call = await pool.query<{ conversation_id: string | null; from_e164: string | null }>(
    "SELECT conversation_id, from_e164 FROM calls WHERE call_control_id = $1",
    [ccid],
  );
  const existing = call.rows[0]?.conversation_id;
  if (existing) return existing;

  if (!call.rowCount) {
    // No call row: an event for a call that was never opened. Fall back to the
    // console thread rather than dropping what was said on the floor.
    const conv = await pool.query<{ id: string }>(
      "SELECT id FROM conversations WHERE project_id IS NULL ORDER BY created_at LIMIT 1",
    );
    return conv.rows[0]?.id ?? null;
  }

  const made = await pool.query<{ id: string }>(
    `INSERT INTO conversations (project_id, title, channel)
     VALUES (NULL, $1, 'phone') RETURNING id`,
    [`Call from ${call.rows[0].from_e164 ?? "an unknown number"}`],
  );
  const id = made.rows[0].id;
  await pool.query("UPDATE calls SET conversation_id = $2 WHERE call_control_id = $1", [ccid, id]);
  return id;
}

/**
 * End a call: write its transcript down, then release the state.
 *
 * The transcript is an artifact rather than only a thread because "every call
 * gets a stored transcript artifact" is the step's Done-when, and because the
 * thread is a live object while the artifact is the record of what was actually
 * said — one file, one checksum, one retention clock.
 */
export async function finalizeCall(pool: pg.Pool, ccid: string, reason: string): Promise<string | null> {
  const call = await pool.query<{
    conversation_id: string | null; from_e164: string | null;
    started_at: string; turns: number; transcript_artifact_id: string | null;
  }>(
    `SELECT conversation_id, from_e164, started_at::text AS started_at, turns, transcript_artifact_id
     FROM calls WHERE call_control_id = $1`,
    [ccid],
  );
  const row = call.rows[0];
  await endCall(pool, ccid, reason);
  if (!row) return null;
  // Written once. A second hangup event for the same call must not produce a
  // second transcript that supersedes nothing.
  if (row.transcript_artifact_id) return row.transcript_artifact_id;

  const lines = row.conversation_id
    ? (await pool.query<{ role: string; body: string; at: string }>(
        `SELECT role, body, to_char(created_at, 'HH24:MI:SS') AS at FROM messages
         WHERE conversation_id = $1 ORDER BY created_at, id`,
        [row.conversation_id],
      )).rows
    : [];

  const body = [
    `# Call from ${row.from_e164 ?? "an unknown number"}`,
    "",
    `- started: ${row.started_at}`,
    `- ended because: ${reason}`,
    `- turns: ${row.turns}`,
    "",
    ...(lines.length
      ? lines.map((l) => `**${l.role === "user" ? "Enrique" : "Jarvis"}** (${l.at}): ${l.body}`)
      : ["_Nothing was said._"]),
    "",
  ].join("\n");

  const dir = path.join(ARTIFACTS, "phone");
  await fs.mkdir(dir, { recursive: true, mode: 0o750 });
  const name = `transcript-${ccid.replace(/[^a-zA-Z0-9-]/g, "")}.md`;
  await fs.writeFile(path.join(dir, name), body, { mode: 0o640 });

  const artifact = await recordArtifact(pool, {
    projectId: null,
    path: path.join("phone", name),
    type: "document",
    mime: "text/markdown",
    bytes: Buffer.byteLength(body),
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    source: "phone",
    conversationId: row.conversation_id,
  }).catch((err) => {
    console.error("call transcript could not be recorded:", err instanceof Error ? err.message : err);
    return null;
  });
  if (artifact) {
    await pool.query(
      "UPDATE calls SET transcript_artifact_id = $2 WHERE call_control_id = $1",
      [ccid, artifact.id],
    );
    /*
     * S41: the transcript is a copy, and it outlives the call.
     *
     * "A call where a confidential document was discussed produces a transcript
     * CONTAINING THAT DISCUSSION, stored under ordinary retention, indexed by
     * S30, and reachable by any future recall - including by voice. That is a
     * leak inside Jarvis rather than to a vendor, and it is the sort that
     * compounds."
     *
     * So the artifact is stamped with the strictest classification of anything
     * discussed. `calls.discussed_projects` is the evidence and is EMPTY today -
     * nothing yet records what a call touched - which means strictestOf([])
     * gives `restricted`. That is the fail-closed answer S41 asks for: "a call
     * whose subject nobody recorded is not a call to read back aloud on the
     * strength of that absence." It gates SPEECH, not the console, so the
     * transcript stays readable where he can already see everything.
     *
     * Never allowed to cost him the transcript: a stamping failure is reported
     * and the artifact stands, because an unstamped transcript is a smaller
     * problem than a lost one, and the read side treats NULL as unstamped rather
     * than as normal.
     */
    const { projectsDiscussedOn, stampTranscript } = await import("./recall.js");
    /*
     * DERIVED from what the call produced - an inbox event routed to a project,
     * or a task created in one, on this call's conversation - rather than read
     * from a list something had to remember to append to. A missed append would
     * understate what was discussed and under-classify the transcript, which is
     * the wrong direction to be wrong in.
     *
     * Anything already on the row is kept alongside, so a caller that DOES know
     * something this cannot derive is not overwritten by the derivation.
     */
    const recorded = await pool.query<{ ids: string[] }>(
      "SELECT discussed_projects AS ids FROM calls WHERE call_control_id = $1",
      [ccid],
    ).catch(() => ({ rows: [] as { ids: string[] }[] }));
    const derived = await projectsDiscussedOn(pool, row.conversation_id)
      .catch(() => [] as string[]);
    const discussedProjectIds = [...new Set([...(recorded.rows[0]?.ids ?? []), ...derived])];
    await stampTranscript(pool, {
      callControlId: ccid,
      transcriptArtifactId: artifact.id,
      discussedProjectIds,
    }).catch((err) => {
      console.error("call transcript could not be classified:",
        err instanceof Error ? err.message : err);
      return null;
    });
  }

  /*
   * S24: what the call was about, written down at the end and filed where a
   * LATER call can find it. Never allowed to fail the hang-up: a call that
   * cannot be summarised is still a call that ended.
   */
  const { finishReview } = await import("./callreview.js");
  await finishReview(pool, ccid).catch((err) =>
    console.error("could not summarise the call:", err instanceof Error ? err.message : err));

  return artifact?.id ?? null;
}

/**
 * Say something to the caller, whatever it takes.
 *
 * ElevenLabs first; if it cannot render, Telnyx's own voice, with an issue
 * raised — a robot voice is a degradation worth knowing about, and silence is
 * not an option the caller can distinguish from a dropped line.
 */
/**
 * Every line Jarvis spoke, when the line is faked.
 *
 * A rendered line goes out as a URL, so `sentCommands` cannot show what was
 * actually said — and "did it say it was still working, or did it say
 * something else" is exactly what the tests need to know.
 */
export const spokenLines: { ccid: string; text: string; clientState: string }[] = [];

async function say(
  pool: pg.Pool, ccid: string, text: string, clientState: string,
): Promise<boolean> {
  if (FAKE_TELNYX) spokenLines.push({ ccid, text, clientState });
  const url = await renderSpeech(pool, text).catch(() => null);
  if (url) return await command(pool, ccid, "playback_start", { audio_url: url, client_state: clientState });

  await raiseIssue(pool, {
    category: "dependency.unavailable",
    service: "elevenlabs",
    title: "[elevenlabs] speech could not be rendered; fell back to the Telnyx voice",
    // Keyed on the failure, not on the call: one ticket while it is down, not
    // one per sentence spoken during the outage.
    dedupeKey: "elevenlabs-render-failed",
    evidence: { call_control_id: ccid, spoke_in: "the carrier voice" },
  }).catch(() => undefined);

  return await command(pool, ccid, "speak", {
    payload: text, voice: "female", language: "en-US", client_state: clientState,
  });
}

/**
 * Words that are not a turn.
 *
 * Telnyx transcribes what it hears, and what it hears on an open line includes
 * coughs, a television, and the engine's own guesses at silence — "you" and
 * "thank you" are the classic ones. Answering those is worse than missing them:
 * it talks over a caller who has not finished thinking.
 */
const NOISE = new Set([
  "uh", "um", "umm", "hmm", "mm", "mhm", "ah", "oh", "eh", "er",
  "you", "thank you", "thanks", "bye", "okay", "ok", "yeah", "hm",
  "[noise]", "[silence]", "[inaudible]", "(silence)",
]);

/**
 * Is this a caller taking a turn, or is it the room?
 *
 * Confidence first when the engine reports it — it is the only signal that is
 * actually about the audio rather than about the words. Then the noise
 * vocabulary, which only fires on a WHOLE utterance: "okay" alone is the room,
 * "okay, book it" is an instruction.
 */
export function looksLikeSpeech(text: string, payload: Record<string, unknown> = {}): boolean {
  const clean = text.trim().toLowerCase().replace(/[.,!?]+$/g, "");
  if (!clean) return false;

  const d = (payload.transcription_data ?? payload) as Record<string, unknown>;
  const confidence = typeof d.confidence === "number" ? d.confidence : null;
  if (confidence !== null && confidence < 0.4) return false;

  if (NOISE.has(clean)) return false;
  // A single syllable that is not a word we know is a cough, not a sentence.
  if (clean.length < 3 && !/^(no|hi|go)$/.test(clean)) return false;
  return true;
}

/**
 * When the caller stops talking, the turn passes — but not before.
 *
 * The timer lives in memory because it is a LATENCY device: five seconds after
 * the last syllable, not five seconds after whenever the next sweep happens to
 * run. What makes it safe is that it decides nothing. The turn is claimed by an
 * atomic UPDATE, and the same claim is attempted by the worker sweep from the
 * `endpoint` deadline in the row — so if this process dies holding a timer, the
 * caller is answered a few seconds later instead of never.
 */
const endpointTimers = new Map<string, NodeJS.Timeout>();

function armEndpoint(pool: pg.Pool, ccid: string): void {
  const existing = endpointTimers.get(ccid);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    endpointTimers.delete(ccid);
    void takeTurn(pool, ccid).catch((err) =>
      console.error("taking the turn failed:", err instanceof Error ? err.message : err));
  }, BUDGET_MS.endpoint);
  // Never hold the process open for a call that has gone quiet.
  t.unref?.();
  endpointTimers.set(ccid, t);
}

function disarmEndpoint(ccid: string): void {
  const t = endpointTimers.get(ccid);
  if (t) clearTimeout(t);
  endpointTimers.delete(ccid);
}

/**
 * The caller has finished. Hand the whole utterance to the runtime.
 *
 * Everything after "persist it" belongs to S21: the acknowledgement, the tool
 * track, the progress ladder and the handover. What stays here is the carrier —
 * how a line becomes audio and how the state machine records that it did.
 */
export async function takeTurn(pool: pg.Pool, ccid: string): Promise<string> {
  if (!(await beginAnswer(pool, ccid))) return "not our turn";
  const heard = await takeUtterance(pool, ccid);
  if (!heard) {
    await endAnswer(pool, ccid);
    return "nothing was said";
  }
  disarmEndpoint(ccid);

  const conversationId = await callConversation(pool, ccid);
  if (!conversationId) {
    await endAnswer(pool, ccid);
    return "no conversation to answer in";
  }

  /*
   * Persist-first, before a model sees it and before anything is said about it.
   * The runtime then routes this same row through `ingestUserMessage` — the
   * path a WhatsApp message takes — so what he said is captured and routed no
   * matter how the conversation goes.
   */
  const inbox = await pool.query<{ id: string }>(
    `INSERT INTO inbox_events
       (channel, sender, raw_text, checksum, capture_state, processing_state, conversation_id)
     VALUES ('phone', 'enrique', $1, $2, 'persisted', 'pending', $3)
     RETURNING id`,
    [
      heard.slice(0, 8000),
      crypto.createHash("sha256").update(heard).digest("hex").slice(0, 32),
      conversationId,
    ],
  );

  try {
    return await runTurn(pool, {
      ccid,
      conversationId,
      inboxId: inbox.rows[0].id,
      heard,
      speak: (text, kind) => speakTurnLine(pool, ccid, text, kind),
      release: () => endAnswer(pool, ccid),
      canSpeak: async () => (await currentState(pool, ccid)) === "listening",
    });
  } catch (err) {
    await endAnswer(pool, ccid);
    throw err;
  }
}

/**
 * Enrique started talking while Jarvis was talking. Jarvis stops. Immediately.
 *
 * "Being talked over by your own assistant is the single most irritating failure
 * in voice UX." Nothing is awaited before the stop goes out except the stop
 * itself: the state move, the counter, and the accumulation all happen after the
 * command is on its way.
 */
async function bargeIn(pool: pg.Pool, ccid: string, marker: string | null): Promise<void> {
  // S21: the scheduler goes first. A progress line queued for eight seconds'
  // time is audio that has not been rendered yet, and cancelling the playback
  // while leaving the timer running means being interrupted and then
  // interrupted again by the thing that was already on its way.
  cancelTurn(ccid);
  await command(pool, ccid, "playback_stop", marker ? { client_state: marker } : {});
  await command(pool, ccid, "speak_stop").catch(() => false);
  await move(pool, ccid, "listening", {
    // `thinking` too: an acknowledgement and every progress line are spoken
    // while the tool track runs, and "everything is interruptible — the
    // acknowledgement was never the point" means interrupting one of those has
    // to work exactly like interrupting an answer.
    from: ["speaking", "greeting", "thinking"],
    cause: "the caller spoke over the reply",
    eventType: "call.transcription",
    leg: "listening",
  });
  await countBargeIn(pool, ccid);
  await setSpeakingMarker(pool, ccid, null);
}

/**
 * Say one line of a turn, as the runtime asks for it (plan S21).
 *
 * The `client_state` is what tells the two apart on the way back: an ANSWER
 * ends the turn when its playback ends, an acknowledgement does not. Getting
 * that wrong is how a caller gets the floor back in the middle of being
 * answered — Telnyx echoes the marker, and it is the only reliable signal.
 */
async function speakTurnLine(
  pool: pg.Pool, ccid: string, text: string, kind: SpeechKind,
): Promise<boolean> {
  const ending = kind === "answer" || kind === "handover" || kind === "closing";
  const marker = ending ? STATE_REPLY : STATE_ACK;
  if (ending) {
    // `tts` until the audio is in the air, then `playing`. A long answer takes
    // longer to PLAY than to render, and budgeting the playback with the render
    // budget is what cut a real answer off after seven seconds.
    await move(pool, ccid, "speaking", { from: "thinking", cause: "playing the answer", leg: "tts" });
  }
  await setSpeakingMarker(pool, ccid, marker);
  const spoke = await say(pool, ccid, text, marker);
  if (ending && spoke) {
    await move(pool, ccid, "speaking", {
      from: "speaking", cause: "the answer is playing", leg: "playing",
    });
  }
  return spoke;
}


/**
 * How long a live call may sit with nothing happening before it is written off.
 *
 * Not a leg budget — a backstop for the events that never arrive at all.
 */
const STALL_MS = 10 * 60_000;

/**
 * Say something to a caller who has been waiting too long, and unstick the call.
 *
 * Run from the worker rather than from a timer inside the request that started
 * the leg. "A hung call is almost always an awaited promise with no timeout" —
 * and a timeout that lives in a promise dies with the process, which is the very
 * failure this step exists to remove. In the row, swept from outside, it
 * survives the restart.
 */
export async function sweepCallDeadlines(pool: pg.Pool): Promise<string[]> {
  const done: string[] = [];

  for (const call of await overdueCalls(pool)) {
    const { call_control_id: ccid, state, deadline_leg: leg } = call;

    /*
     * The endpoint deadline is not a failure. It is the caller having stopped
     * talking, and it is here as well as on the in-process timer so that an API
     * restart mid-sentence costs a few seconds rather than the whole turn.
     */
    if (leg === "endpoint") {
      const took = await takeTurn(pool, ccid);
      done.push(`${ccid}: ${took}`);
      continue;
    }

    if (state === "listening") {
      // Nobody has said anything — and nothing is half-said either, or the
      // endpoint branch above would have taken it. This test has to come
      // SECOND: a caller pausing mid-sentence is also in `listening`, and
      // asking them whether they are still there is precisely the interruption
      // this step exists to remove.
      const asked = await bumpSilence(pool, ccid);
      if (asked >= 2) {
        await say(pool, ccid, "I will let you go, sir. Call back any time.", STATE_ACK);
        await command(pool, ccid, "hangup");
        await finalizeCall(pool, ccid, "the caller went quiet");
        done.push(`${ccid}: closed after silence`);
        continue;
      }
      await say(pool, ccid, "Are you still there, sir?", STATE_ACK);
      await move(pool, ccid, "listening", {
        from: "listening", cause: "asked whether the caller is still there", leg: "listening",
      });
      done.push(`${ccid}: asked whether the caller is still there`);
      continue;
    }

    /*
     * A playback that never ended is a truncated answer, and a truncated answer
     * is a FAILURE, not a state transition. On the call of 2026-09-02 this path
     * quietly spoke a holding line over the top of the answer and moved on;
     * nothing was raised, and the only evidence was a transition row.
     */
    if (leg === "playing") {
      await raiseIssue(pool, {
        category: "dependency.unavailable",
        service: "telnyx",
        title: "[phone] an answer was cut off before it finished playing",
        dedupeKey: `phone.playback-truncated:${ccid}`,
        evidence: { call_control_id: ccid, state },
        requiredAction:
          "The caller heard part of an answer. Check the recording and the answer_text on call_turns.",
      }).catch(() => undefined);
      await pool
        .query(
          `UPDATE call_turns SET outcome = 'failed'
           WHERE call_control_id = $1 AND outcome = 'answered'
             AND id = (SELECT max(id) FROM call_turns WHERE call_control_id = $1)`,
          [ccid],
        )
        .catch(() => undefined);
      await move(pool, ccid, "listening", {
        from: ["speaking"], cause: "the answer was cut off", leg: "listening",
      });
      done.push(`${ccid}: an answer was cut off`);
      continue;
    }

    // A leg blew its budget. Say something true about it, and hand the turn
    // back to the caller — a gate that is never released is a deaf call.
    await say(pool, ccid, holdingLine(leg), STATE_REPLY);
    await move(pool, ccid, "listening", {
      from: ["greeting", "thinking", "speaking", "ringing"],
      cause: `the ${leg ?? "current"} leg blew its budget`,
      leg: "listening",
    });
    done.push(`${ccid}: ${leg ?? "a leg"} overran, said so and went back to listening`);
  }

  for (const call of await stalledCalls(pool, STALL_MS)) {
    await finalizeCall(pool, call.call_control_id, `stalled in ${call.state}`);
    done.push(`${call.call_control_id}: written off, stalled in ${call.state}`);
  }

  return done;
}

/**
 * Render the fixed lines ahead of time.
 *
 * Everything here is known before any call: the acknowledgements, the filler,
 * and all three greetings. Rendering them at boot means the first caller of the
 * day does not pay ~900ms of synthesis on a line that exists precisely to
 * remove dead air.
 */
export async function warmPhoneAudio(pool: pg.Pool): Promise<void> {
  /*
   * S21: the acknowledgement bank is warmed too. "Pre-render the
   * acknowledgement bank; a fixed phrase should never pay for synthesis twice"
   * — and the acknowledgement has a 700ms budget it cannot meet if it is
   * waiting on ElevenLabs the first time each line is used.
   */
  const { everyFixedLine } = await import("./callbank.js");
  const lines = [
    "Good morning, sir. What can I do for you?",
    "Good afternoon, sir. What can I do for you?",
    "Good evening, sir. What can I do for you?",
    ...everyFixedLine(),
  ];
  for (const line of lines) {
    await renderSpeech(pool, line).catch(() => undefined);
  }
  console.log(`phone audio warmed: ${lines.length} lines`);
}

/**
 * The inbound call state machine.
 *
 * Returns a short description of what it did, for the webhook's own logging.
 * Every branch is deliberately cheap: the webhook must answer Telnyx quickly,
 * so anything slow (transcription, a Supervisor turn) happens after the
 * recording arrives, on a later event, not while a call is waiting.
 */
/**
 * Is this `call.initiated` our OWN outbound leg rather than somebody calling in?
 *
 * Telnyx sends `call.initiated` for both directions. The owner check was applied
 * to all of them, so every call Jarvis placed was measured against "is the
 * caller Enrique?", answered no - the caller is Jarvis - and was rejected. Five
 * of them in one day. The calls survived only because a later event with no row
 * invents one, so what looked like a working outbound call was a rejection
 * followed by an accident.
 *
 * Two signals, both local:
 *
 *   the ccid is one we placed  authoritative, and unspoofable: it comes from
 *                              our own API response, not from the wire.
 *   the from is our own number  covers the race where the webhook beats the
 *                              write of that ccid.
 *
 * The second is caller-controlled, so it must never GRANT anything. It does not:
 * an outbound leg is neither answered nor rejected here, so a spoofer claiming
 * to be our number gets silence, which is what an unrecognised caller should
 * get anyway.
 */
async function isOwnOutboundLeg(
  pool: pg.Pool,
  ccid: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  if (String(payload.direction ?? "").toLowerCase() === "outgoing") return true;

  const ours = await pool
    .query<{ n: string }>(
      `SELECT count(*) AS n FROM outbound_calls WHERE call_control_id = $1`,
      [ccid],
    )
    .catch(() => null);
  if (Number(ours?.rows[0]?.n ?? 0) > 0) return true;

  const from = String(payload.from ?? "");
  const mine = sitePin((c) => c.telnyx?.from_e164);
  return Boolean(mine && from === mine);
}

export async function handleCallEvent(pool: pg.Pool, event: TelnyxEvent): Promise<string> {
  const type = event.data?.event_type ?? "";
  const payload = (event.data?.payload ?? {}) as Record<string, unknown>;
  const ccid = String(payload.call_control_id ?? "");

  // A dropped `call.initiated` must not cost the whole call. Without a row every
  // gate refuses, and the caller hears a greeting followed by nothing.
  if (ccid && type !== "call.initiated") {
    const invented = await ensureCall(pool, {
      ccid,
      legId: String(payload.call_leg_id ?? "") || null,
      from: String(payload.from ?? "") || null,
    });
    if (invented) console.error(`no call row for ${ccid}; ${type} arrived first, invented one`);
  }

  if (type === "call.initiated" && ccid) {
    /*
     * Our own outbound leg: record it and let it proceed. Answering is the
     * callee's job, and rejecting it would be Jarvis hanging up on itself.
     */
    if (await isOwnOutboundLeg(pool, ccid, payload)) {
      await ensureCall(pool, {
        ccid,
        legId: String(payload.call_leg_id ?? "") || null,
        from: String(payload.from ?? "") || null,
      });
      return "outbound leg initiated";
    }

    const verdict = callerVerdict(payload);
    if (!verdict.allow) {
      await command(pool, ccid, "reject", { cause: "CALL_REJECTED" });
      await raiseIssue(pool, {
        category: "security.broker_deny",
        service: "telnyx",
        title: "[telnyx] rejected a call from an unrecognised number",
        // Keyed on the reason, not the caller — one ticket per failure mode
        // rather than one per nuisance call.
        dedupeKey: `phone.rejected:${verdict.reason}`,
        evidence: { from: verdict.from, reason: verdict.reason },
        requiredAction: "If this was you, check owner_e164 in site.yaml and your caller ID attestation.",
        notifyOverride: "ui_only",
      }).catch(() => undefined);
      return `rejected: ${verdict.reason}`;
    }
    await openCall(pool, { ccid, legId: String(payload.call_leg_id ?? "") || null, from: verdict.from });
    await command(pool, ccid, "answer");
    return `answered: ${verdict.reason}`;
  }

  if (type === "call.answered" && ccid) {
    // Speak only. Recording starts on `call.speak.ended`, never here: firing
    // both together recorded Jarvis's own greeting off the line, and Whisper
    // dutifully transcribed it back as if the caller had said it.
    // Play the rendered file. Falls back to Telnyx's own voice only if the
    // render or the playback fails — a wrong voice beats silence, but it is
    // never the first choice.
    const url = await greetingUrl(pool);
    let spoke = false;
    if (url) {
      spoke = await command(pool, ccid, "playback_start", {
        audio_url: url,
        client_state: STATE_GREETING,
      });
    }
    if (!spoke) {
      spoke = await command(pool, ccid, "speak", {
        payload: greetingText(),
        voice: "female",
        language: "en-US",
      });
      if (spoke) console.error("greeting fell back to the Telnyx voice");
    }
    if (!spoke) {
      // A voice that Telnyx cannot resolve must not strand the caller on a
      // silent line that never records. Fall back to recording immediately.
      console.error("speak failed; recording without a greeting");
      // Straight to listening: a greeting that cannot be spoken must not leave
      // the caller on a silent line that never records.
      await move(pool, ccid, "greeting", { from: "ringing", cause: "greeting failed", eventType: type });
      await move(pool, ccid, "listening", {
        from: "greeting", cause: "no greeting to wait for", leg: "listening",
      });
      await startRecording(pool, ccid);
      return "speak failed, recording anyway";
    }
    await move(pool, ccid, "greeting", {
      from: "ringing", cause: "playing the greeting", eventType: type, leg: "tts",
    });
    return "greeting";
  }

  if ((type === "call.speak.ended" || type === "call.playback.ended") && ccid) {
    // Only the greeting arms listening. Without this gate every reply's own
    // playback.ended started another transcription and another recording, so
    // one utterance produced several transcriptions, each producing a reply,
    // each arming more sessions — the call ran away, and five recordings were
    // saved on hangup. Telnyx echoes client_state back on the event, which is
    // the only way to tell the two playbacks apart.
    const state = String(payload.client_state ?? "");
    if (state === STATE_ACK) return "acknowledgement finished, still thinking";
    if (state !== STATE_GREETING) {
      // The answer has finished playing: the caller may speak again.
      await endAnswer(pool, ccid);
      await setSpeakingMarker(pool, ccid, null);
      /*
       * Anything said WHILE Jarvis was talking is a turn that has been waiting.
       * Without this it sat in `pending_text` until the caller said something
       * else — so interrupting worked, and being answered after interrupting
       * did not.
       */
      const waiting = await pool.query<{ pending_text: string | null }>(
        "SELECT pending_text FROM calls WHERE call_control_id = $1", [ccid]);
      if (waiting.rows[0]?.pending_text) {
        armEndpoint(pool, ccid);
        return "reply finished, a turn is waiting";
      }
      return "reply finished, listening again";
    }
    // Two things, for two different jobs.
    //
    // Recording exists for the audio artifact and its 7-day clock (L12). It
    // cannot drive conversation: `record_start` only saves at max_length or at
    // hangup, so the transcript always arrived after the caller had given up
    // and the call_control_id was already dead.
    //
    // Transcription streams instead, and only the inbound track — so Jarvis
    // never transcribes its own voice back and answers itself.
    await move(pool, ccid, "listening", {
      from: "greeting", cause: "the greeting finished", eventType: type, leg: "listening",
    });
    await startRecording(pool, ccid);
    await command(pool, ccid, "transcription_start", {
      transcription_engine: "Telnyx",
      transcription_tracks: "inbound",
      transcription_engine_config: { language: "en", interim_results: false },
    });
    return "listening";
  }

  if (type === "call.transcription" && ccid) {
    const said = transcriptFrom(payload);
    if (said === null) return "transcription with no final text";
    if (said === "") {
      // Gate it like a real answer, so a run of empty finals produces one
      // apology rather than one per event.
      if (!(await beginAnswer(pool, ccid))) return "already answering";
      await say(pool, ccid, holdingLine("stt"), STATE_REPLY);
      return "heard nothing usable, said so";
    }

    // The room is not a turn. A television, a cough, and the engine's own guess
    // at silence all arrive here looking exactly like speech.
    if (!looksLikeSpeech(said, payload)) return `ignored as noise: ${said.slice(0, 40)}`;

    const call = await pool.query<{ state: CallState; speaking_marker: string | null }>(
      "SELECT state, speaking_marker FROM calls WHERE call_control_id = $1",
      [ccid],
    );
    const state = call.rows[0]?.state ?? null;

    /*
     * Barge-in. S19 refused a transcription that arrived while Jarvis was
     * speaking, which was right for "one utterance, one reply" and wrong for a
     * human being: it meant the only way to interrupt was to wait. Now the
     * playback stops and the caller has the floor. The turn gate still holds —
     * it is `listening` again a moment later, and what they said accumulates
     * like any other utterance.
     */
    if (state === "speaking" || state === "greeting" || state === "thinking") {
      await bargeIn(pool, ccid, call.rows[0]?.speaking_marker ?? null);
    }

    // Thinking: the reply is already being composed, so this belongs to the
    // NEXT turn. It accumulates and is taken when the current answer finishes.
    const whole = await appendUtterance(pool, ccid, said);
    // Only a call that is listening is waiting for the caller to finish. Said
    // over a reply being composed, it waits for that reply to land first.
    if (state === "listening" || state === "speaking" || state === "greeting" || state === "thinking") {
      armEndpoint(pool, ccid);
    }
    return `heard "${said.slice(0, 40)}", turn so far ${whole.length} chars`;
  }

  if (type === "call.recording.saved") {
    const url = String(
      (payload.recording_urls as { mp3?: string } | undefined)?.mp3 ?? payload.public_recording_urls ?? "",
    );
    const legId = String(payload.call_leg_id ?? crypto.randomUUID());
    if (!url) return "recording saved with no url";

    const stored = await storeRecording(pool, url, legId);
    if (!stored) return "recording could not be stored";
    // S24: the call remembers its recording, so the console can offer it while
    // it exists and say plainly when retention has taken it.
    await pool
      .query("UPDATE calls SET recording_artifact_id = $2 WHERE call_control_id = $1", [ccid, stored.id])
      .catch(() => undefined);

    const text = await transcribe(pool, stored.full);
    if (!text) return `stored ${stored.id}, transcription unavailable`;

    const conv = await pool.query<{ id: string }>(
      `SELECT id FROM conversations WHERE project_id IS NULL ORDER BY created_at LIMIT 1`,
    );
    const inbox = await pool.query<{ id: string }>(
      `INSERT INTO inbox_events
         (channel, sender, raw_text, checksum, capture_state, processing_state, conversation_id)
       VALUES ('phone', 'enrique', $1, $2, 'persisted', 'pending', $3)
       RETURNING id`,
      [
        text.slice(0, 8000),
        crypto.createHash("sha256").update(text).digest("hex").slice(0, 32),
        conv.rows[0]?.id ?? null,
      ],
    );

    // The recording exists for the audio artifact and its retention clock, not
    // for the conversation — it arrives after the caller has hung up.
    return `stored ${stored.id}, transcript filed`;
  }

  /*
   * Hang-up, and anything else that ends a call, releases the state. The plan:
   * "Hang-up, caller silence, and mid-call network loss all end the call cleanly
   * and release state." A row left in `thinking` forever is the persisted
   * version of the stuck Map this replaced.
   */
  if ((type === "call.hangup" || type === "call.machine.detection.ended") && ccid) {
    await finalizeCall(pool, ccid, `telnyx said ${type}`);
    return `call ended: ${type}`;
  }

  return `ignored ${type}`;
}

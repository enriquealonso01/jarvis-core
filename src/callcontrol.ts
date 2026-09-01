import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type pg from "pg";
import { readJsonCredential } from "./credentials.js";
import { sitePin } from "./siteconfig.js";
import { raiseIssue } from "./notify.js";
import { runSupervisorTurn } from "./supervisor.js";
import { ARTIFACTS_DIR } from "./paths.js";

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
 * Which calls are mid-answer.
 *
 * `interim_results: false` does not mean one event per utterance — Telnyx emits
 * a final per segment, so a single spoken sentence can arrive as two, and each
 * one produced its own spoken reply. A call answers one thing at a time: this
 * gate holds from the moment a transcription is accepted until that reply has
 * finished playing.
 *
 * In memory because it is per-live-call and worthless after the call ends; the
 * timestamp is the escape hatch, so a lost playback.ended cannot wedge a call
 * silent forever.
 */
const answering = new Map<string, number>();
const ANSWER_LOCK_MS = 30_000;

function beginAnswer(ccid: string): boolean {
  const since = answering.get(ccid);
  if (since && Date.now() - since < ANSWER_LOCK_MS) return false;
  answering.set(ccid, Date.now());
  return true;
}

function endAnswer(ccid: string): void {
  answering.delete(ccid);
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
async function command(
  pool: pg.Pool,
  callControlId: string,
  action: string,
  body: Record<string, unknown> = {},
): Promise<boolean> {
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

async function transcribe(pool: pg.Pool, filePath: string): Promise<string | null> {
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
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
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

/** Render any line of speech in the pinned voice and return a playable URL. */
export async function renderSpeech(pool: pg.Pool, text: string): Promise<string | null> {
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
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=ulaw_8000`,
    {
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
    return null;
  }
  return text;
}

/** Run a Supervisor turn on what was said and play the answer back. */
async function answerAloud(pool: pg.Pool, ccid: string, said: string): Promise<string> {
  const startedAt = Date.now();


  const conv = await pool.query<{ id: string }>(
    `SELECT id FROM conversations WHERE project_id IS NULL ORDER BY created_at LIMIT 1`,
  );
  const conversationId = conv.rows[0]?.id;
  if (!conversationId) return "no conversation to answer in";

  const inbox = await pool.query<{ id: string }>(
    `INSERT INTO inbox_events
       (channel, sender, raw_text, checksum, capture_state, processing_state, conversation_id)
     VALUES ('phone', 'enrique', $1, $2, 'persisted', 'pending', $3)
     RETURNING id`,
    [said.slice(0, 8000), crypto.createHash("sha256").update(said).digest("hex").slice(0, 32), conversationId],
  );

  // §13.3: a phone call cannot authorise an always-confirm action. Caller ID is
  // spoofable and a voice can be cloned, so a spoken instruction is a request to
  // be confirmed elsewhere, never authority in itself.
  const reply = await runSupervisorTurn(pool, {
    conversationId,
    inboxId: inbox.rows[0].id,
    userText:
      `[Spoken by Enrique on the phone. You may call him "sir" occasionally, the way a butler `
      + `would - not in every sentence, and never twice in one reply. Reply in ONE short sentence - `
      + `it is read aloud over a phone line, so brevity matters more than completeness. No `
      + `lists, no markdown, no preamble. This channel can never authorise a destructive or `
      + `always-confirm action: if he asks for one, say it needs confirming in the Control `
      + `Center.]

${said}`,
    brief: true,
    // Stays on the paid supervisor chain. Routing spoken turns at the free-tier
    // utility chain was quick right up until Groq hit its daily limit mid-call.
    // Measured head to head on Fireworks, the supervisor model is also simply
    // the fastest of the three: deepseek-v4-flash 1226ms, glm-5p3-flash 2705ms,
    // nemotron-lightning 3594ms. The 5.5s seen on real calls is context, not the
    // model — full system prompt, twelve messages of history, eleven tool
    // schemas, and a second round trip whenever a tool is called.
  }).catch((err) => {
    console.error("phone supervisor turn failed:", err instanceof Error ? err.message : err);
    return null;
  });

  const spoken = reply ?? "Sorry sir, I could not reach a model just then. Your message is saved.";
  const afterModel = Date.now();
  const url = await renderSpeech(pool, spoken);
  // Split the wait so the slow half is known rather than guessed at.
  console.log(
    `phone turn: model ${afterModel - startedAt}ms, tts ${Date.now() - afterModel}ms, `
    + `reply ${spoken.length} chars`,
  );
  if (url) {
    await command(pool, ccid, "playback_start", { audio_url: url, client_state: STATE_REPLY });
  } else {
    await command(pool, ccid, "speak", {
      payload: spoken,
      voice: "female",
      language: "en-US",
      client_state: STATE_REPLY,
    });
  }
  return `answered ${spoken.length} chars`;
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
  const lines = [
    "Good morning, sir. What can I do for you?",
    "Good afternoon, sir. What can I do for you?",
    "Good evening, sir. What can I do for you?"];
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
export async function handleCallEvent(pool: pg.Pool, event: TelnyxEvent): Promise<string> {
  const type = event.data?.event_type ?? "";
  const payload = (event.data?.payload ?? {}) as Record<string, unknown>;
  const ccid = String(payload.call_control_id ?? "");

  if (type === "call.initiated" && ccid) {
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
      await startRecording(pool, ccid);
      return "speak failed, recording anyway";
    }
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
      endAnswer(ccid);
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
    if (!said) return "transcription with no final text";
    if (!beginAnswer(ccid)) return `ignored while answering: ${said.slice(0, 40)}`;
    try {
      return await answerAloud(pool, ccid, said);
    } catch (err) {
      endAnswer(ccid);
      throw err;
    }
  }

  if (type === "call.recording.saved") {
    const url = String(
      (payload.recording_urls as { mp3?: string } | undefined)?.mp3 ?? payload.public_recording_urls ?? "",
    );
    const legId = String(payload.call_leg_id ?? crypto.randomUUID());
    if (!url) return "recording saved with no url";

    const stored = await storeRecording(pool, url, legId);
    if (!stored) return "recording could not be stored";

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

  return `ignored ${type}`;
}

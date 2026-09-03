/**
 * How he wants to be spoken to, changed by asking (plan S43).
 *
 *   "**Any user-configurable part of Jarvis can be changed by asking, on any
 *    channel.**... How Jarvis communicates — tone, what it calls him, how much
 *    detail by default, when it calls, which channel it prefers for what."
 *
 *   "Communication preferences are stored, versioned, and **actually consulted**
 *    — a preference nothing reads is a preference that does not exist."
 *
 * NO NEW TABLE, AND NO SECOND WRITER. S27 built `config_versions` with scope,
 * key, value, version, supersedes, conversation_id and caused_by_message, and
 * S43 says outright that "S27 already does these; this generalises the
 * entrance" and "everything versioned and reversible (S27)".
 *
 * This file writes preferences through `applyConfigChange` rather than
 * INSERTing, and that is not tidiness — S27's own suite asserts that exactly one
 * file writes a version row, and it caught this file doing it directly. Going
 * through the one writer also means preferences inherit the immutable-domain
 * refusal, the version numbering and the supersedes chain rather than
 * reimplementing three things that would then have to be kept in step.
 *
 * THE CHANNEL IS A DIMENSION OF THE VALUE, NOT THE OWNER OF THE RECORD, and this
 * is the design decision in the file. The Debug note says why:
 *
 *   "If preferences apply on one channel and not another, they are being read at
 *    the wrong layer. **Preferences belong to the conversation and the user, not
 *    to the transport.**"
 *
 * So "be more detailed in chat but keep WhatsApp short" is ONE preference — one
 * row, one version, one thing to roll back — whose value happens to vary by
 * channel: `{ default, byChannel }`. Storing `web.detail_level` and
 * `whatsapp.detail_level` as separate keys would put the transport in charge of
 * the record, and then a preference set with no channel in mind reaches nothing,
 * a rollback rolls back one surface, and the failure looks exactly like the one
 * the Debug note describes.
 */
import type pg from "pg";
import { applyConfigChange, rollbackConfig } from "./config.js";

/**
 * What he can change this way. A closed set, so an unrecognised preference is
 * refused loudly rather than written into a row nothing will ever read — which
 * is the "preference that does not exist" failure arriving by typo.
 */
export const PREFERENCE_KEYS = [
  "comm.address_as",
  "comm.detail_level",
  "comm.preferred_channel",
  "comm.call_window",
] as const;
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

export function isPreferenceKey(k: string): k is PreferenceKey {
  return (PREFERENCE_KEYS as readonly string[]).includes(k);
}

/** One preference: what it is by default, and where it differs. */
export type PreferenceValue = {
  default: string | null;
  byChannel?: Record<string, string>;
};

export type Resolved = {
  value: string | null;
  /** Which layer answered, so "applies on one channel and not another" is diagnosable. */
  from: "channel" | "default" | "unset";
  version: number;
};

/**
 * Change a preference.
 *
 * A NEW VERSION every time, superseding the last, rather than an update in
 * place: "everything versioned and reversible". A `channel` narrows the change
 * to one surface and leaves the default alone; without one the default moves and
 * every channel that has not been given its own answer follows it.
 */
export async function setPreference(
  pool: pg.Pool,
  args: {
    key: string;
    value: string | null;
    /** Narrow this to one surface. Absent means "how I want it generally". */
    channel?: string | null;
    actor?: string;
    conversationId?: string | null;
    causedByMessage?: string | null;
  },
): Promise<{ version: number; value: PreferenceValue }> {
  if (!isPreferenceKey(args.key)) {
    throw new Error(`${args.key} is not a communication preference; nothing would read it`);
  }

  const current = await currentRow(pool, args.key);
  /*
   * Built from the previous value rather than replacing it, so "keep WhatsApp
   * short" does not silently discard "be more detailed in chat" said a minute
   * earlier. Two sentences about two channels are two edits to one preference.
   */
  const next: PreferenceValue = {
    default: current?.value.default ?? null,
    byChannel: { ...(current?.value.byChannel ?? {}) },
  };
  if (args.channel) {
    next.byChannel = { ...next.byChannel, [args.channel]: args.value ?? "" };
  } else {
    next.default = args.value;
  }

  const outcome = await applyConfigChange(pool, {
    scope: "global",
    projectId: null,
    key: args.key,
    value: next,
    actor: args.actor ?? "enrique",
    note: args.channel ? `on ${args.channel}` : "everywhere",
    conversationId: args.conversationId ?? null,
    causedByMessage: args.causedByMessage ?? null,
  });
  if (!outcome.applied) {
    throw new Error(`${args.key} was not applied: ${JSON.stringify(outcome)}`);
  }
  return { version: outcome.version, value: next };
}

async function currentRow(
  pool: pg.Pool,
  key: string,
): Promise<{ id: string; version: number; value: PreferenceValue } | null> {
  const r = await pool.query<{ id: string; version: number; value: PreferenceValue }>(
    `SELECT id, version, value FROM config_versions
      WHERE scope = 'global' AND key = $1
      ORDER BY version DESC LIMIT 1`,
    [key],
  );
  return r.rows[0] ?? null;
}

/**
 * What applies here.
 *
 * The channel is asked of the VALUE, not used to pick a row. That is the whole
 * point: one preference, one version, one rollback, and a per-surface answer
 * where he has given one.
 */
export async function preferenceFor(
  pool: pg.Pool,
  key: string,
  channel?: string | null,
): Promise<Resolved> {
  const current = await currentRow(pool, key);
  if (!current) return { value: null, from: "unset", version: 0 };
  const byChannel = current.value.byChannel ?? {};
  if (channel && Object.hasOwn(byChannel, channel) && byChannel[channel] !== "") {
    return { value: byChannel[channel], from: "channel", version: current.version };
  }
  return { value: current.value.default ?? null, from: "default", version: current.version };
}

/**
 * Put it back exactly as it was.
 *
 * "Roll one back -> previous behaviour returns EXACTLY." So this writes the
 * previous VALUE forward as a new version rather than deleting the current row:
 * the history stays a history, and what he heard between the two changes remains
 * explicable afterwards. Deleting would make the rollback invisible and the
 * audit wrong about what was in force at the time.
 */
export async function rollbackPreference(
  pool: pg.Pool,
  key: string,
  actor = "enrique",
): Promise<{ version: number; value: PreferenceValue } | null> {
  const rows = await pool.query<{ version: number; value: PreferenceValue }>(
    `SELECT version, value FROM config_versions
      WHERE scope = 'global' AND key = $1
      ORDER BY version DESC LIMIT 2`,
    [key],
  );
  const previous = rows.rows[1];
  if (!previous) return null;

  /*
   * S27's rollback, not a second one. It writes the old value FORWARD as a new
   * version rather than deleting the current row, which is the behaviour this
   * step wants anyway: the history stays a history, and what he heard between
   * the two changes remains explicable afterwards.
   */
  const outcome = await rollbackConfig(pool, {
    projectId: null, key, toVersion: previous.version, actor,
  });
  if (!outcome.applied) return null;
  return { version: outcome.version, value: previous.value };
}

/* ------------------------------------------------------------------ *
 * Actually consulted. "A preference nothing reads is a preference that
 * does not exist."
 * ------------------------------------------------------------------ */

/** The default when he has never said. His full name, which is what S19 used. */
export const DEFAULT_ADDRESS = "Enrique";

/**
 * What to call him on this channel.
 *
 * "Stop calling me Enrique in voice calls, use my first name only" is a phone
 * sentence that has to be audible on the NEXT call, so the greeting is built
 * from this rather than from a constant somebody would have to remember to
 * change in two places.
 */
export async function addressAs(pool: pg.Pool, channel?: string | null): Promise<string> {
  const r = await preferenceFor(pool, "comm.address_as", channel);
  return r.value || DEFAULT_ADDRESS;
}

/** How much detail belongs on this surface, as a character budget. */
export const DETAIL_BUDGETS: Record<string, number> = {
  short: 280,
  normal: 700,
  detailed: 2000,
};

export const DEFAULT_DETAIL = "normal";

/**
 * The budget a reply on this channel gets.
 *
 * Returned as a NUMBER the composer uses, not as a label it is trusted to
 * interpret: a preference read into a variable nobody multiplies by is the same
 * as a preference nothing reads.
 */
export async function detailBudgetFor(pool: pg.Pool, channel?: string | null): Promise<number> {
  const r = await preferenceFor(pool, "comm.detail_level", channel);
  const level = r.value && Object.hasOwn(DETAIL_BUDGETS, r.value) ? r.value : DEFAULT_DETAIL;
  return DETAIL_BUDGETS[level];
}

/**
 * A reply, trimmed to what he asked for on this surface.
 *
 * This exists so the suite can assert that changing a preference changes an
 * OUTPUT, rather than that a row was written. "Actually consulted" is not
 * observable from the preferences table.
 */
export async function composeReply(
  pool: pg.Pool,
  channel: string,
  body: string,
): Promise<{ text: string; budget: number; addressed: string }> {
  const budget = await detailBudgetFor(pool, channel);
  const addressed = await addressAs(pool, channel);
  const text = body.length <= budget ? body : `${body.slice(0, budget - 1).trimEnd()}…`;
  return { text, budget, addressed };
}

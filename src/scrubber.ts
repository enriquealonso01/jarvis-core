/**
 * The output scrubber (Part V, S12b item 3).
 *
 * "Never logged" is the easiest security property to state, the easiest to
 * violate by accident, and invisible until the day it matters. Until now it had
 * nothing behind it at all.
 *
 * It matches on the actual decrypted values held in memory, NOT on patterns.
 * The plan is explicit about why: "pattern matching finds `sk-...` and misses a
 * 44-character password." Every credential this process has decrypted is
 * registered here, and every string on the way out — a log line, an issue
 * evidence blob, an audit `metadata`, an artifact, any parameter bound into any
 * SQL statement — is checked against the real values.
 *
 * The resolution of the tension the plan names: provider error bodies are kept,
 * because a bare status code once turned a five-minute diagnosis into an
 * afternoon, and they are kept SCRUBBED, because a provider that echoes the
 * request echoes the `Authorization` header with it. Store the body; never store
 * it raw.
 */

/** value -> the name it is redacted as. */
const live = new Map<string, string>();

/**
 * How short a secret may be before it is too dangerous to match on.
 *
 * A four-character value would redact half of every log line it appears in. Real
 * credentials are long; a short one is either not a secret or is being stored
 * wrongly, and neither is fixed by scrubbing it.
 */
const MIN_LENGTH = 12;

/**
 * Register a credential's values as things that must never appear in output.
 *
 * Called wherever a credential is decrypted, so registration cannot be forgotten
 * at a call site: if a value has been read, it is registered.
 */
export function registerSecret(payload: Record<string, unknown>, label: string): void {
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (typeof value !== "string") continue;
    const v = value.trim();
    if (v.length < MIN_LENGTH) continue;
    // The label names the connection, not the field: `[redacted:groq]` says
    // enough to debug with and nothing that helps an attacker.
    live.set(v, label);
    /*
     * A private key is also worth catching line by line. Its PEM body is what
     * ends up in a log when something prints the whole object, and the body is
     * what matters — not the header line every key shares.
     */
    if (key.includes("private_key") || v.includes("PRIVATE KEY")) {
      for (const line of v.split("\n")) {
        const t = line.trim();
        if (t.length >= 40 && !t.startsWith("---")) live.set(t, label);
      }
    }
  }
}

/** For the tests, and for a process that wants to start clean. */
export function forgetSecrets(): void {
  live.clear();
}

/** How many values are currently guarded. */
export function secretCount(): number {
  return live.size;
}

/**
 * Replace every live credential value in a string.
 *
 * Longest first: a value that contains another value must be replaced whole,
 * or the inner one is redacted and the outer one is left half-visible.
 */
export function scrub<T>(input: T): T {
  if (!live.size) return input;
  if (typeof input === "string") return scrubString(input) as unknown as T;
  return input;
}

export function scrubString(text: string): string {
  if (!live.size || !text) return text;
  let out = text;
  const values = [...live.keys()].sort((a, b) => b.length - a.length);
  for (const value of values) {
    if (!out.includes(value)) continue;
    out = out.split(value).join(`[redacted:${live.get(value)}]`);
  }
  return out;
}

/** Deeply scrub anything that will be written down or sent on. */
export function scrubDeep<T>(value: T): T {
  if (typeof value === "string") return scrubString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Put the scrubber in front of every log line this process writes.
 *
 * Wrapping the console rather than asking every caller to remember: "every log
 * line passes a filter" is a property of the process, and a property that
 * depends on nobody forgetting is not a property.
 */
export function installLogScrubber(): void {
  const g = globalThis as { __jarvisLogScrubbed?: boolean };
  if (g.__jarvisLogScrubbed) return;
  g.__jarvisLogScrubbed = true;
  for (const method of ["log", "error", "warn", "info", "debug"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args.map((a) => (typeof a === "string" ? scrubString(a) : scrubDeep(a))));
    };
  }
}

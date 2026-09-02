import fs from "node:fs";
import { parse } from "yaml";

/**
 * `/etc/jarvis/site.yaml` — the operator-pinned settings the plan keeps
 * referring to (ElevenLabs voice_id, the WhatsApp numbers, the Telnyx pair).
 *
 * Nothing read this file. The `yaml` dependency was installed, blockers told
 * Enrique to edit it, and the ElevenLabs service line was hardcoded to say
 * "no voice_id pinned in site.yaml yet" — so it said that whatever the file
 * contained, and every value written there was inert. Setting the voice_id
 * changed nothing until this existed.
 *
 * Read fresh with a short cache: it is edited by hand on the host, and a
 * process that only reads it at boot makes an edit look ignored.
 */
export type SiteConfig = {
  site?: { public_url?: string };
  whatsapp?: { jarvis_e164?: string; owner_e164?: string };
  elevenlabs?: { voice_id?: string };
  telnyx?: {
    from_e164?: string;
    to_e164?: string;
    public_key?: string;
    voice_name?: string;
    /** S23: the Call Control application an outbound dial is placed through. */
    connection_id?: string;
  };
};

const SITE_PATH = process.env.JARVIS_SITE_YAML ?? "/etc/jarvis/site.yaml";
const CACHE_MS = 30_000;

let cached: { at: number; value: SiteConfig } | null = null;

export function siteConfig(): SiteConfig {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  let value: SiteConfig = {};
  try {
    value = (parse(fs.readFileSync(SITE_PATH, "utf8")) as SiteConfig) ?? {};
  } catch {
    // A missing or malformed file means "nothing pinned", which every caller
    // already handles. It must not take the API down.
    value = {};
  }
  cached = { at: now, value };
  return value;
}

/** Trimmed, or null — an empty string in the file means unset, not "". */
export function sitePin(path: (c: SiteConfig) => string | undefined): string | null {
  const raw = path(siteConfig());
  const v = typeof raw === "string" ? raw.trim() : "";
  return v ? v : null;
}

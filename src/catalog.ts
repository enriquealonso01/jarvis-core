import type pg from "pg";
import { readJsonCredential } from "./credentials.js";
import { raiseIssue } from "./notify.js";
import { CHAT_MAX_TOKENS, CHAT_TEMPERATURE } from "./chatparams.js";
import { meteredAllowed } from "./quota.js";

/**
 * Plan §35 roles. Order inside each list is the failover order.
 * Nothing is written as "approved" until a live call to that exact model id
 * succeeds — provider catalogs list model ids that are no longer servable
 * (Gemini retires models for new users while still listing them), and a
 * hardcoded id that 404s silently breaks the whole failover chain.
 */
export type ModelRole =
  | "supervisor"
  | "utility"
  | "senior_engineer"
  | "reviewer"
  | "stt"
  | "voice_tts"
  | "vision"
  | "embeddings";

export const PROVIDER_CHAT_URL: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
  fireworks: "https://api.fireworks.ai/inference/v1/chat/completions",
};

export const PROVIDER_PROFILE: Record<string, string> = {
  groq: "groq",
  fireworks: "fireworks",
  google: "google_ai",
  nvidia: "nvidia",
  elevenlabs: "elevenlabs",
  anthropic: "anthropic_personal",
  openai_codex: "openai_codex_personal",
  cursor: "cursor_personal",
};

type Candidate = {
  provider: string;
  /** Exact ids to try, best first. */
  wanted: string[];
  /** Substring fallbacks if none of `wanted` are listed. */
  contains: string[];
  roles: ModelRole[];
  route_order: number;
  /**
   * Licence and price travel with the candidate, not with a one-off migration.
   * The catalog picks the provider's *listed* id — Fireworks answered with
   * `deepseek-v4-flash-0731`, not the bare id — so anything written against a
   * guessed id lands on a row that never serves traffic, and the row that does
   * serve comes back unpriced and flagged closed-weight.
   */
  open_weights?: boolean;
  license?: string;
  input_cost_per_mtok?: number;
  output_cost_per_mtok?: number;
};

/**
 * Bootstrap routes from docs/INITIAL_MODEL_ROUTING.md, expressed as
 * provider-scoped candidates. Ids are still checked against the live catalog.
 */
export const CANDIDATES: Candidate[] = [
  // Supervisor: Groq primary, then Google, then NVIDIA.
  // Paid, MIT-weighted, and first in the chain. CANDIDATES is re-applied by every
  // catalog verification, so a route added only in SQL would be silently reverted
  // here — the two have to agree.
  // Supervisor only. Giving it `utility` as well made the two roles resolve to
  // the same model, so "route the phone at utility for speed" would have changed
  // nothing — INITIAL_MODEL_ROUTING puts gpt-oss-20b at the head of utility.
  { provider: "fireworks", wanted: ["accounts/fireworks/models/deepseek-v4-flash"], contains: ["deepseek-v4-flash"], roles: ["supervisor"], route_order: 0,
    open_weights: true, license: "MIT", input_cost_per_mtok: 0.22, output_cost_per_mtok: 0.66 },
  { provider: "groq", wanted: ["openai/gpt-oss-120b"], contains: ["gpt-oss-120"], roles: ["supervisor"], route_order: 20,
    open_weights: true, license: "Apache-2.0" },
  // Utility only from S25. Supervisor keeps a primary and ONE fallback; this was
  // the third and served 1 call in the life of the table.
  { provider: "groq", wanted: ["qwen/qwen3.8-27b", "qwen/qwen3.6-27b"], contains: ["qwen3"], roles: ["utility"], route_order: 30,
    open_weights: true, license: "Apache-2.0" },
  { provider: "google", wanted: ["gemini-3.6-flash", "gemini-flash-latest", "gemini-3.5-flash"], contains: ["flash"], roles: ["vision"], route_order: 60 },
  // Reviewer only, for the same reason. It served 2 calls, always as a fallback.
  { provider: "nvidia", wanted: ["nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-ultra-550b-a55b"], contains: ["nemotron-3-super"], roles: ["reviewer"], route_order: 10 },

  // Utility / fast triage.
  { provider: "groq", wanted: ["openai/gpt-oss-20b"], contains: ["gpt-oss-20"], roles: ["utility"], route_order: 10,
    open_weights: true, license: "Apache-2.0" },

  /*
   * Engineering and review on the hosted open-weights provider (S25).
   *
   * What used to be here was three free-tier candidates — NVIDIA Kimi, NVIDIA
   * DeepSeek-Pro, Gemini Pro — all `degraded`, none of which had ever served a
   * call. That is the "dead free-tier chain" the step is told to delete, and it
   * had to be deleted HERE as well as in SQL: this list is re-applied by every
   * catalog verification, so a row removed only by migration comes back within
   * the hour. The plan's own Debug note predicted exactly that.
   *
   * The two that replace them are chosen, priced and justified in
   * migrations/028_quota_routing.sql. Kimi K2.7 Code is the named engineering
   * fallback; GLM-5.3 is a reviewer from a different family than the Claude
   * implementer, which is what VI.3 is actually asking for.
   */
  { provider: "fireworks", wanted: ["accounts/fireworks/models/kimi-k2p7-code"], contains: ["kimi-k2p7-code"], roles: ["senior_engineer"], route_order: 40,
    open_weights: true, license: "Modified MIT", input_cost_per_mtok: 0.95, output_cost_per_mtok: 4.0 },
  { provider: "fireworks", wanted: ["accounts/fireworks/models/glm-5p3"], contains: ["glm-5p3"], roles: ["reviewer"], route_order: 4,
    open_weights: true, license: "MIT", input_cost_per_mtok: 1.4, output_cost_per_mtok: 4.4 },
];

/** Non-chat roles: listed, not chat-probed. */
export const NON_CHAT: Candidate[] = [
  { provider: "groq", wanted: ["whisper-large-v3-turbo", "whisper-large-v3"], contains: ["whisper"], roles: ["stt"], route_order: 10 },
  { provider: "nvidia", wanted: ["nvidia/nemotron-3-embed-1b", "nvidia/llama-3.2-nv-embedqa-1b-v1"], contains: ["embed"], roles: ["embeddings"], route_order: 30 },
];

async function apiKeyFor(pool: pg.Pool, profileId: string): Promise<string | null> {
  const row = await pool.query<{ credential_id: string | null }>(
    "SELECT credential_id FROM auth_profiles WHERE id = $1",
    [profileId],
  );
  const id = row.rows[0]?.credential_id;
  if (!id) return null;
  const payload = await readJsonCredential(pool, id);
  return payload.api_key ?? null;
}

async function upsertModel(
  pool: pg.Pool,
  row: {
    provider: string;
    model_id: string;
    roles: string[];
    health: string;
    approval_state: "approved" | "discovered" | "disabled";
    route_order: number;
    auth_profile_id: string | null;
    endpoint_url: string | null;
    last_error: string | null;
    open_weights?: boolean;
    license?: string;
    input_cost_per_mtok?: number;
    output_cost_per_mtok?: number;
  },
) {
  await pool.query(
    `INSERT INTO model_registry
       (provider, model_id, role_assignments, health, approval_state,
        route_order, auth_profile_id, endpoint_url, last_checked_at, last_error,
        open_weights, license, input_cost_per_mtok, output_cost_per_mtok)
     -- coalesce on insert: open_weights is NOT NULL DEFAULT false, and passing an
     -- explicit null overrides the default rather than falling back to it, so
     -- every candidate that did not declare economics failed the whole upsert —
     -- and with it the entire catalog verification, silently.
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9, coalesce($10, false), $11, $12, $13)
     ON CONFLICT (provider, model_id) DO UPDATE SET
       role_assignments = EXCLUDED.role_assignments,
       health = EXCLUDED.health,
       approval_state = EXCLUDED.approval_state,
       route_order = EXCLUDED.route_order,
       auth_profile_id = EXCLUDED.auth_profile_id,
       endpoint_url = EXCLUDED.endpoint_url,
       last_checked_at = now(),
       last_error = EXCLUDED.last_error,
       -- coalesce: a candidate that omits economics must not blank what is
       -- already recorded for that row.
       open_weights = coalesce(EXCLUDED.open_weights, model_registry.open_weights, false),
       license = coalesce(EXCLUDED.license, model_registry.license),
       input_cost_per_mtok = coalesce(EXCLUDED.input_cost_per_mtok, model_registry.input_cost_per_mtok),
       output_cost_per_mtok = coalesce(EXCLUDED.output_cost_per_mtok, model_registry.output_cost_per_mtok)`,
    [
      row.provider,
      row.model_id,
      row.roles,
      row.health,
      row.approval_state,
      row.route_order,
      row.auth_profile_id,
      row.endpoint_url,
      row.last_error,
      row.open_weights ?? null,
      row.license ?? null,
      row.input_cost_per_mtok ?? null,
      row.output_cost_per_mtok ?? null,
    ],
  );
}

function pick(ids: string[], wanted: string[], contains: string[]): string | null {
  for (const w of wanted) {
    if (ids.includes(w)) return w;
  }
  for (const part of contains) {
    const hit = ids.find((id) => id.toLowerCase().includes(part.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

async function listOpenAiStyle(
  url: string,
  key: string,
  notes?: string[],
  provider?: string,
): Promise<string[]> {
  // A failure here used to return [] silently, and the candidate loop then
  // `continue`d without a note — so a provider with a stored key and a wrong
  // listing simply vanished from the catalog output. That is how Fireworks
  // disappeared: no "ok", no "degraded", no line at all. Say what happened.
  const label = provider ?? url;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) {
      const body = (await res.text()).replace(/\s+/g, " ").slice(0, 160);
      notes?.push(`${label} model listing failed: HTTP ${res.status} ${body}`);
      return [];
    }
    const json = (await res.json()) as { data?: { id: string }[] };
    const ids = (json.data ?? []).map((m) => m.id);
    if (!ids.length) notes?.push(`${label} model listing returned no models`);
    return ids;
  } catch (err) {
    notes?.push(`${label} model listing threw: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function listGoogle(key: string): Promise<string[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
  );
  if (!res.ok) return [];
  const json = (await res.json()) as { models?: { name: string }[] };
  return (json.models ?? []).map((m) => m.name.replace(/^models\//, ""));
}


/**
 * The tool payload used to validate a route. Imported lazily from the Supervisor
 * so the probe and the real turn cannot drift apart.
 */
let cachedProbeTools: unknown[] | null = null;
function probeTools(): unknown[] {
  return cachedProbeTools ?? [];
}

/** Called once at startup so probeChat can send the real catalog. */
export function setProbeTools(tools: unknown[]): void {
  cachedProbeTools = tools;
}

/** One cheap tool-enabled call. A model that cannot take tools is useless as a Supervisor route. */
async function probeChat(
  url: string,
  key: string,
  model: string,
  timeoutMs = 45_000,
): Promise<{ ok: boolean; detail: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: ac.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "Reply with the single word OK." },
          { role: "user", content: "ping" },
        ],
        // The probe must send what production sends. A minimal `noop` tool
        // passed on NVIDIA while the real catalog was rejected for using dots
        // in function names, so a route could be "healthy" and fail every turn.
        tools: probeTools(),
        // Same sampling parameters as a real turn. max_tokens is a ceiling, not
        // a spend, so matching production costs nothing and stops a route from
        // passing here on parameters it would never see in use.
        max_tokens: CHAT_MAX_TOKENS,
        temperature: CHAT_TEMPERATURE,
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).replace(/\s+/g, " ").slice(0, 300);
      return { ok: false, detail: `HTTP ${res.status} ${body}` };
    }
    return { ok: true, detail: "" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyCatalogs(pool: pg.Pool): Promise<{ groq: boolean; notes: string[] }> {
  const notes: string[] = [];

  const keys: Record<string, string | null> = {
    groq: await apiKeyFor(pool, "groq"),
    google: await apiKeyFor(pool, "google_ai"),
    nvidia: await apiKeyFor(pool, "nvidia"),
    fireworks: await apiKeyFor(pool, "fireworks"),
  };

  const listed: Record<string, string[]> = { groq: [], google: [], nvidia: [], fireworks: [] };
  if (keys.groq) listed.groq = await listOpenAiStyle("https://api.groq.com/openai/v1/models", keys.groq, notes, "groq");
  if (keys.nvidia) listed.nvidia = await listOpenAiStyle("https://integrate.api.nvidia.com/v1/models", keys.nvidia, notes, "nvidia");
  if (keys.google) listed.google = await listGoogle(keys.google);
  // Fireworks speaks the OpenAI listing shape, so no special case beyond the URL.
  if (keys.fireworks) {
    listed.fireworks = await listOpenAiStyle(
      "https://api.fireworks.ai/inference/v1/models",
      keys.fireworks,
      notes,
      "fireworks",
    );
  }

  // Probe each distinct (provider, model_id) once, then attach every role that wanted it.
  const chosen = new Map<
    string,
    {
      provider: string;
      model: string;
      roles: Set<string>;
      route_order: number;
      open_weights?: boolean;
      license?: string;
      input_cost_per_mtok?: number;
      output_cost_per_mtok?: number;
    }
  >();
  for (const c of CANDIDATES) {
    const key = keys[c.provider];
    if (!key) {
      notes.push(`${c.provider}:${c.roles.join("/")} skipped — no credential stored`);
      continue;
    }
    if (!listed[c.provider]?.length) {
      notes.push(`${c.provider}:${c.roles.join("/")} skipped — provider listed no models`);
      continue;
    }
    const model = pick(listed[c.provider], c.wanted, c.contains);
    if (!model) {
      notes.push(`${c.provider}:${c.roles.join("/")} no candidate listed`);
      continue;
    }
    const mapKey = `${c.provider}::${model}`;
    const entry = chosen.get(mapKey);
    if (entry) {
      c.roles.forEach((r) => entry.roles.add(r));
      entry.route_order = Math.min(entry.route_order, c.route_order);
    } else {
      chosen.set(mapKey, {
        provider: c.provider,
        model,
        roles: new Set<string>(c.roles),
        route_order: c.route_order,
        open_weights: c.open_weights,
        license: c.license,
        input_cost_per_mtok: c.input_cost_per_mtok,
        output_cost_per_mtok: c.output_cost_per_mtok,
      });
    }
  }

  let hasGroqSupervisor = false;
  for (const entry of chosen.values()) {
    const key = keys[entry.provider] as string;
    const url = PROVIDER_CHAT_URL[entry.provider];
    const probe = await probeChat(url, key, entry.model);
    const health = probe.ok ? "healthy" : classifyRouteFailure(probe.detail);
    await upsertModel(pool, {
      provider: entry.provider,
      model_id: entry.model,
      roles: [...entry.roles],
      open_weights: entry.open_weights,
      license: entry.license,
      input_cost_per_mtok: entry.input_cost_per_mtok,
      output_cost_per_mtok: entry.output_cost_per_mtok,
      health,
      // A transiently failing route stays approved so failover can retry it;
      // only a hard failure drops back to `discovered`.
      approval_state: probe.ok || health === "degraded" ? "approved" : "discovered",
      route_order: entry.route_order,
      auth_profile_id: PROVIDER_PROFILE[entry.provider] ?? null,
      endpoint_url: url,
      last_error: probe.ok ? null : probe.detail,
    });
    notes.push(`${entry.provider}/${entry.model} ${probe.ok ? "ok" : `${health}: ${probe.detail}`}`);
    if (probe.ok && entry.provider === "groq" && entry.roles.has("supervisor")) hasGroqSupervisor = true;
  }

  // Non-chat roles: listed only.
  for (const c of NON_CHAT) {
    const key = keys[c.provider];
    if (!key || !listed[c.provider]?.length) continue;
    const model = pick(listed[c.provider], c.wanted, c.contains);
    if (!model) continue;
    await upsertModel(pool, {
      provider: c.provider,
      model_id: model,
      roles: c.roles,
      health: "healthy",
      approval_state: "approved",
      route_order: c.route_order,
      auth_profile_id: PROVIDER_PROFILE[c.provider] ?? null,
      endpoint_url: null,
      last_error: null,
    });
    notes.push(`${c.provider}/${model} (${c.roles.join(",")})`);
  }

  // ElevenLabs TTS.
  if (await apiKeyFor(pool, "elevenlabs")) {
    await upsertModel(pool, {
      provider: "elevenlabs",
      model_id: "eleven_multilingual_v2",
      roles: ["voice_tts"],
      health: "healthy",
      approval_state: "approved",
      route_order: 10,
      auth_profile_id: "elevenlabs",
      endpoint_url: null,
      last_error: null,
    });
  }

  // Host-subscription harnesses (ADR 006). No API key exists for these; health
  // tracks the host login, and they stay out of the API failover chain.
  const hostRoutes: {
    provider: string;
    profile: string;
    model: string;
    roles: ModelRole[];
    order: number;
  }[] = [
    { provider: "anthropic", profile: "anthropic_personal", model: "claude-sonnet-host", roles: ["senior_engineer", "reviewer"], order: 5 },
    { provider: "openai_codex", profile: "openai_codex_personal", model: "codex-host", roles: ["senior_engineer"], order: 15 },
    { provider: "cursor", profile: "cursor_personal", model: "cursor-acp-host", roles: ["senior_engineer"], order: 20 },
  ];
  for (const h of hostRoutes) {
    const prof = await pool.query<{ health: string }>(
      "SELECT health FROM auth_profiles WHERE id = $1",
      [h.profile],
    );
    const healthy = prof.rows[0]?.health === "healthy";
    await upsertModel(pool, {
      provider: h.provider,
      model_id: h.model,
      roles: h.roles,
      health: healthy ? "healthy" : "pending_auth",
      approval_state: healthy ? "approved" : "discovered",
      route_order: h.order,
      auth_profile_id: h.profile,
      endpoint_url: null,
      last_error: healthy ? null : "host CLI login not completed on the VPS",
    });
  }

  return { groq: hasGroqSupervisor, notes };
}

export type Route = {
  provider: string;
  model_id: string;
  endpoint_url: string;
  auth_profile_id: string;
};

/**
 * Plan §80.1: a project-owned auth profile must never serve the Supervisor or
 * any other system-lane role. A profile counts as project-owned when a
 * project-scoped connection binds it.
 */
export async function projectOwnedProfileIds(pool: pg.Pool): Promise<string[]> {
  const r = await pool.query<{ auth_profile_id: string }>(
    `SELECT DISTINCT auth_profile_id FROM connections
     WHERE project_id IS NOT NULL AND auth_profile_id IS NOT NULL`,
  );
  return r.rows.map((x) => x.auth_profile_id);
}

/** Ordered, live-verified routes for a role. Empty means the role has no usable model. */
export async function routesForRole(pool: pg.Pool, role: ModelRole): Promise<Route[]> {
  const r = await pool.query<Route & { input_cost_per_mtok: string | null }>(
    `SELECT provider, model_id, endpoint_url, auth_profile_id, input_cost_per_mtok::text
     FROM model_registry
     WHERE approval_state = 'approved'
       AND endpoint_url IS NOT NULL
       AND auth_profile_id IS NOT NULL
       AND health IN ('healthy', 'degraded')
       AND $1 = ANY (role_assignments)
     ORDER BY route_order, provider, model_id`,
    [role],
  );

  /*
   * The hard ceiling drops metered routes and nothing else (S25).
   *
   * Every route reached through this function is an HTTP call to a priced
   * provider, so past the ceiling the list empties — and that is the intended
   * behaviour for the Supervisor, which is metered. What must NOT stop is
   * coding work, and it does not, because the engineer ladder runs on
   * subscription logins that never come through here.
   *
   * Unpriced routes are treated as metered. `input_cost_per_mtok IS NULL` means
   * unknown, never free — the same rule `/api/models` reports under
   * `unpriced_routes`.
   */
  if (!(await meteredAllowed(pool))) {
    for (const route of r.rows) {
      await pool.query(
        `INSERT INTO audit_events (actor, action, target, metadata)
         VALUES ('system', 'budget.ceiling_block', $1, $2)`,
        [
          `${route.provider}/${route.model_id}`,
          JSON.stringify({ role, reason: "month-to-date spend is at the hard ceiling" }),
        ],
      ).catch(() => undefined);
    }
    return [];
  }
  if (role !== "supervisor" && role !== "utility") return r.rows;

  const owned = new Set(await projectOwnedProfileIds(pool));
  const allowed: Route[] = [];
  for (const route of r.rows) {
    if (!owned.has(route.auth_profile_id)) {
      allowed.push(route);
      continue;
    }
    // Denied before any HTTP call reaches the provider, and recorded.
    await pool.query(
      `INSERT INTO audit_events (actor, action, target, metadata)
       VALUES ('system', 'security.isolation', $1, $2)`,
      [
        route.auth_profile_id,
        JSON.stringify({
          reason: "project-owned auth profile refused for a system role",
          role,
          provider: route.provider,
          model_id: route.model_id,
        }),
      ],
    );
  }
  return allowed;
}

export async function supervisorModelId(pool: pg.Pool): Promise<string | null> {
  const routes = await routesForRole(pool, "supervisor");
  return routes[0]?.model_id ?? null;
}

/**
 * How badly a route failed, from the provider's error text.
 *
 * A quota window, a cold NIM endpoint, or a timeout is not a dead model: it
 * stays routable as `degraded` so failover can reach it again in 10 minutes
 * rather than 60.
 *
 * This lives in one place because it did not used to. The probe treated 429,
 * 5xx and timeouts as transient while the Supervisor's failover treated only
 * 429 that way, so an intermittent 500 seen during a real turn benched the route
 * for an hour — six times longer than the identical error seen by a probe.
 * NVIDIA, the one Supervisor route that is not free-tier quota limited, was
 * being sidelined by exactly that.
 */
export function classifyRouteFailure(detail: string): "degraded" | "failed" {
  const transient =
    detail.startsWith("HTTP 429") ||
    detail.startsWith("HTTP 5") ||
    /abort|timeout|fetch failed|ECONNRESET|socket hang up/i.test(detail);
  return transient ? "degraded" : "failed";
}

export async function markRouteHealth(
  pool: pg.Pool,
  provider: string,
  modelId: string,
  health: "healthy" | "degraded" | "failed",
  error: string | null,
): Promise<void> {
  /*
   * IV.9's "model changed", audited on the TRANSITION only.
   *
   * This function runs on every health check, so auditing each call would bury
   * the trail in rows saying nothing changed. What is worth attributing is a
   * route going healthy, degraded or failed — which is when the Supervisor's
   * chain actually moves.
   */
  const before = await pool.query<{ health: string }>(
    "SELECT health FROM model_registry WHERE provider = $1 AND model_id = $2",
    [provider, modelId],
  );
  const previous = before.rows[0]?.health ?? null;

  await pool.query(
    `UPDATE model_registry
     SET health = $3, last_error = $4, last_checked_at = now()
     WHERE provider = $1 AND model_id = $2`,
    [provider, modelId, health, error],
  );

  if (previous !== health) {
    const { audit } = await import("./audit.js");
    await audit(pool, {
      actor: "catalog",
      action: "model.change",
      target: `${provider}/${modelId}`,
      model: modelId,
      outcome: health === "healthy" ? "allowed" : "failed",
      reason: health === "healthy" ? null : (error ?? `route is ${health}`),
      extra: { provider, from: previous, to: health },
    });
  }

  // A pinned model that the provider no longer serves needs a person to re-pin
  // it; nothing else will. NVIDIA retired `nemotron-3-super-120b-a12b` and the
  // only trace was a `failed` row in model_registry that no page reads — the
  // route silently left the Supervisor chain. A 404/400 is not a 429: it will
  // not come back on its own, so it is worth a ticket where a quota window is not.
  const permanent = health === "failed" && /HTTP 40[0-9]/.test(error ?? "");
  if (!permanent) return;

  // Routed through raiseIssue rather than a hand-written insert: `issues` has an
  // owner CHECK ('jarvis' | 'user' | 'provider') and its dedupe index is partial
  // (open rows only), so an ON CONFLICT on that column does not match it. Both
  // are already handled correctly in one place.
  await raiseIssue(pool, {
    category: "provider.model_retired",
    service: "models",
    owner: "user",
    title: `[models] ${provider}/${modelId} is no longer served`,
    requiredAction:
      "Re-pin this role to a model that exists in the provider's current catalog, "
      + "or remove the route. Improvement's weekly catalog refresh can propose one.",
    dedupeKey: `models.retired:${provider}/${modelId}`,
    evidence: { provider, model_id: modelId, last_error: (error ?? "").slice(0, 300) },
  }).catch(() => undefined);
}

/**
 * Re-probe routes that a transient failure knocked down.
 *
 * A 429 marks a route `degraded`, but nothing restored it: once the free tier
 * rate-limited the primary it stayed degraded forever, so the health signal
 * decayed to "everything is degraded" while chat carried on working through the
 * fallbacks. Health has to be able to go back up.
 */
export async function reprobeDegradedRoutes(pool: pg.Pool): Promise<{ restored: string[] }> {
  const rows = await pool.query<{
    provider: string;
    model_id: string;
    endpoint_url: string;
    auth_profile_id: string;
  }>(
    // `failed` is included on a longer interval. A hard failure can be a payload
    // bug we have since fixed or a provider blip; without a way back the
    // fallback chain shrinks permanently and silently.
    `SELECT provider, model_id, endpoint_url, auth_profile_id
     FROM model_registry
     WHERE approval_state = 'approved'
       AND endpoint_url IS NOT NULL
       AND auth_profile_id IS NOT NULL
       AND (
         (health = 'degraded' AND (last_checked_at IS NULL OR last_checked_at < now() - interval '10 minutes'))
         OR (health = 'failed' AND (last_checked_at IS NULL OR last_checked_at < now() - interval '60 minutes'))
       )
     ORDER BY route_order
     LIMIT 6`,
  );

  const restored: string[] = [];
  for (const row of rows.rows) {
    const key = await apiKeyFor(pool, row.auth_profile_id);
    if (!key) continue;
    const probe = await probeChat(row.endpoint_url, key, row.model_id, 15_000);
    if (probe.ok) {
      await pool.query(
        `UPDATE model_registry SET health = 'healthy', last_error = NULL, last_checked_at = now()
         WHERE provider = $1 AND model_id = $2`,
        [row.provider, row.model_id],
      );
      restored.push(`${row.provider}/${row.model_id}`);
    } else {
      await pool.query(
        `UPDATE model_registry SET last_checked_at = now(), last_error = $3
         WHERE provider = $1 AND model_id = $2`,
        [row.provider, row.model_id, probe.detail],
      );
    }
  }
  return { restored };
}

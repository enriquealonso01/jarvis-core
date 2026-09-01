import crypto from "node:crypto";
import type pg from "pg";
import { ARTIFACTS_DIR, BROWSERS_DIR, WORKTREES_DIR } from "./paths.js";
import { readJsonCredential } from "./credentials.js";
import { classifyRouteFailure, markRouteHealth, routesForRole, setProbeTools, type ModelRole } from "./catalog.js";
import { CHAT_MAX_TOKENS, CHAT_TEMPERATURE } from "./chatparams.js";
import { metadataOnlyPayload } from "./redaction.js";
import {
  ONBOARDING_FIELDS,
  PROFESSIONAL_REQUIRED,
  isBooleanish,
  toBoolean,
  validEnum,
  validSlug,
} from "./policy.js";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "memory_upsert",
      description: "Store a durable note. Omit project_id for global Supervisor memory.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string" },
          body: { type: "string" },
          project_id: { type: "string" },
        },
        required: ["kind", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_search",
      description: "Keyword search memory.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_list",
      description: "List Jarvis projects.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "project_onboarding_start",
      description: "Start creating a new project in this conversation.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "project_onboarding_set",
      description: "Set one onboarding field (name, slug, project_type, confidentiality, customer_facing, github optional).",
      parameters: {
        type: "object",
        properties: {
          field: { type: "string" },
          value: { type: "string" },
        },
        required: ["field", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_onboarding_finalize",
      description: "Create the project when name, slug, and project_type are set. GitHub may be omitted.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "conversation_create",
      description: "Open a new conversation thread. Pass project_slug to scope it to a project.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          project_slug: { type: "string" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "connection_list",
      description:
        "List Jarvis connections and whether each one has a stored credential. Use this before telling Enrique how to connect a tool.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "connection_request",
      description:
        "Ask Enrique for a missing credential. Opens an Issue and an action page he can complete. Use this instead of telling him to edit files.",
      parameters: {
        type: "object",
        properties: {
          profile_id: {
            type: "string",
            description: "auth profile id, e.g. groq, google_ai, composio, github_personal_admin",
          },
          reason: { type: "string" },
        },
        required: ["profile_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "issue_create",
      description: "Open an Issue if blocked.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          severity: { type: "string" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "models_list",
      description:
        "The models Jarvis can route to, with their price per million tokens, "
        + "whether the weights are open, and what each has cost this month. Use it "
        + "before answering anything about which model is running, what a turn "
        + "costs, or whether a cheaper or open route exists. The primary route for "
        + "a role is simply its lowest route_order. `role`, if given, must be one "
        + "of: supervisor, utility, senior_engineer, reviewer, stt, voice_tts, "
        + "vision, embeddings - it is not a filter for words like \"primary\".",
      parameters: {
        type: "object",
        properties: { role: { type: "string" } },
      },
    },
  },
];

// Probing with the real catalog is what makes a "healthy" route mean
// "can serve a turn" rather than "answered a simpler request".
setProbeTools(TOOLS);

/**
 * The tools worth carrying on a spoken turn.
 *
 * A phone call is latency-bound, and every schema is prompt tokens on every
 * round trip. Measured head to head the model answers in ~1.2s; real calls took
 * ~5.5s, and the difference is context — eleven schemas, twelve messages of
 * history, and the full system prompt. Project onboarding and thread creation
 * are not things anyone does by voice, so they are left out rather than paid
 * for on every turn.
 */
const PHONE_TOOL_NAMES = new Set([
  "memory_upsert",
  "memory_search",
  "issue_create",
]);

const PHONE_TOOLS = TOOLS.filter((t) => PHONE_TOOL_NAMES.has(t.function.name));

type ChatMsg = { role: string; content?: string | null; tool_calls?: unknown; tool_call_id?: string; name?: string };

/**
 * A provider's response message is not necessarily a valid *request* message.
 * Groq's gpt-oss-120b returns `reasoning_content`, which it then rejects on the
 * way back in ("property 'reasoning_content' is unsupported"), so echoing the
 * reply verbatim broke every turn that called a tool.
 *
 * Allowlist the three fields the chat API accepts for an assistant turn rather
 * than blocklisting known extras, so a new provider field cannot break this again.
 */
/**
 * A reply that says an action was taken, in a turn where no tool ran.
 *
 * Observed live: asked a second time to remember something it had already
 * stored, the Supervisor answered "Stored: ..." without calling memory_upsert.
 * Nothing was written. The earlier row made the claim look true, so no test and
 * no page could tell the difference.
 *
 * This does not block the reply and does not raise an Issue — a claim can be an
 * honest reference to an earlier turn, and a noisy Issue stream is worse than
 * none. It records the discrepancy so the turn is visibly unconfirmed in the
 * conversation instead of silently trusted.
 */
const CLAIM_RE =
  /^\s*(?:ok[,.]?\s*)?(?:i(?:'ve| have)?\s+)?(stored|saved|created|opened|scheduled|added|registered|updated|noted)\b/i;

function claimsAnAction(text: string): boolean {
  return CLAIM_RE.test(text);
}

function assistantForHistory(msg: ChatMsg): ChatMsg {
  const clean: ChatMsg = {
    role: "assistant",
    // Some providers send null content alongside tool_calls; others reject null.
    content: typeof msg.content === "string" ? msg.content : "",
  };
  if (msg.tool_calls) clean.tool_calls = msg.tool_calls;
  return clean;
}


async function getProfileKey(pool: pg.Pool, profileId: string): Promise<string | null> {
  const row = await pool.query<{ credential_id: string | null }>(
    "SELECT credential_id FROM auth_profiles WHERE id = $1 AND credential_id IS NOT NULL",
    [profileId],
  );
  if (!row.rows[0]?.credential_id) return null;
  const payload = await readJsonCredential(pool, row.rows[0].credential_id);
  return payload.api_key ?? null;
}

/**
 * SUPERVISOR.md documents the tool catalog with dots (`memory.upsert`). Those
 * go on the wire as underscores: NVIDIA rejects dots outright ("Only a-z, A-Z,
 * 0-9, underscores, and dashes are allowed"), which meant the NVIDIA fallback
 * failed on every real turn while still passing a simpler catalog probe.
 */
const WIRE_TO_CANONICAL: Record<string, string> = {
  memory_upsert: "memory.upsert",
  memory_search: "memory.search",
  project_list: "project.list",
  project_onboarding_start: "project.onboarding_start",
  project_onboarding_set: "project.onboarding_set",
  project_onboarding_finalize: "project.onboarding_finalize",
  conversation_create: "conversation.create",
  connection_list: "connection.list",
  connection_request: "connection.request",
  issue_create: "issue.create",
  models_list: "models.list",
};

async function runTool(
  pool: pg.Pool,
  conversationId: string,
  inboxId: string,
  rawName: string,
  args: Record<string, string>,
): Promise<string> {
  // Accept either spelling: a model that echoes the documented name still works.
  const name = WIRE_TO_CANONICAL[rawName] ?? rawName;
  if (name === "memory.upsert") {
    // An empty body would persist a row that says nothing and still report
    // success, so it is refused rather than written.
    const body = (args.body ?? "").trim();
    if (!body) {
      return "ERROR: memory.upsert needs a non-empty body. Nothing was stored.";
    }
    const r = await pool.query<{ body: string }>(
      `INSERT INTO memory_items (project_id, kind, body, source_inbox_id)
       VALUES ($1, $2, $3, $4)
       RETURNING body`,
      [args.project_id || null, args.kind || "note", body, inboxId],
    );
    // Echo what was actually persisted, not what was asked for. A turn was seen
    // storing a stale string copied out of the thread history while replying as
    // though the request had been honoured; returning the row makes the real
    // value visible both to the model and on the conversation's tool chip.
    return `stored: ${r.rows[0].body}`;
  }
  if (name === "memory.search") {
    const q = `%${args.query ?? ""}%`;
    const r = await pool.query(
      `SELECT kind, body FROM memory_items
       WHERE body ILIKE $1 OR kind ILIKE $1
       ORDER BY created_at DESC LIMIT 8`,
      [q],
    );
    return JSON.stringify(r.rows);
  }
  if (name === "project.list") {
    const r = await pool.query(`SELECT slug, name, project_type, confidentiality FROM projects WHERE archived_at IS NULL`);
    return JSON.stringify(r.rows);
  }
  if (name === "project.onboarding_start") {
    const r = await pool.query(
      `INSERT INTO onboarding_sessions (conversation_id, status, answers)
       VALUES ($1, 'in_progress', '{}'::jsonb) RETURNING id`,
      [conversationId],
    );
    return JSON.stringify({ onboarding_id: r.rows[0].id });
  }
  if (name === "project.onboarding_set") {
    const sess = await pool.query<{ id: string }>(
      `SELECT id FROM onboarding_sessions WHERE conversation_id = $1 AND status = 'in_progress'
       ORDER BY created_at DESC LIMIT 1`,
      [conversationId],
    );
    if (!sess.rows[0]) return "no in-progress onboarding; call project.onboarding_start";

    const field = (args.field ?? "").trim();
    const value = (args.value ?? "").trim();
    if (!(ONBOARDING_FIELDS as readonly string[]).includes(field)) {
      return `unknown field ${field}. Allowed: ${ONBOARDING_FIELDS.join(", ")}`;
    }
    // Validate here rather than letting a bad value reach a CHECK constraint and
    // abort the whole turn.
    if (field === "slug" && !validSlug(value)) {
      return "slug must be lowercase letters, numbers and hyphens, 3-50 characters, and cannot contain ..";
    }
    if (
      (field === "project_type" || field === "confidentiality" ||
       field === "production_status" || field === "default_queue_priority") &&
      !validEnum(field, value)
    ) {
      return `${field} must be one of the allowed values`;
    }
    if ((field === "customer_facing" || field === "metered_spend_allowed") && !isBooleanish(value)) {
      return `${field} must be yes or no`;
    }

    await pool.query(
      `UPDATE onboarding_sessions
       SET answers = answers || jsonb_build_object($2::text, to_jsonb($3::text)), updated_at = now()
       WHERE id = $1`,
      [sess.rows[0].id, field, value],
    );
    return "ok";
  }
  if (name === "project.onboarding_finalize") {
    const sess = await pool.query<{ id: string; answers: Record<string, string> }>(
      `SELECT id, answers FROM onboarding_sessions WHERE conversation_id = $1 AND status = 'in_progress'
       ORDER BY created_at DESC LIMIT 1`,
      [conversationId],
    );
    if (!sess.rows[0]) return "no in-progress onboarding";
    const a = sess.rows[0].answers ?? {};
    if (!a.name || !a.slug || !a.project_type) {
      return "need name, slug, and project_type";
    }
    // Revalidate at finalize: answers may predate the field rules.
    if (!validSlug(a.slug)) {
      return "slug must be lowercase letters, numbers and hyphens, 3-50 characters";
    }
    if (!validEnum("project_type", a.project_type)) {
      return "project_type must be personal or professional";
    }
    if (a.confidentiality && !validEnum("confidentiality", a.confidentiality)) {
      return "confidentiality must be normal, confidential or restricted";
    }
    if (a.production_status && !validEnum("production_status", a.production_status)) {
      return "production_status must be non_production, staging or production";
    }

    // TEMPLATES.md: a professional project must answer its questions first.
    if (a.project_type === "professional") {
      const missing = PROFESSIONAL_REQUIRED.filter((f) => !a[f]);
      if (missing.length) {
        return `a professional project needs answers for: ${missing.join(", ")}`;
      }
    }

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO projects (slug, name, is_system, project_type, confidentiality,
                             production_status, customer_facing, metered_spend_allowed)
       VALUES ($1, $2, false, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        a.slug,
        a.name,
        a.project_type,
        a.confidentiality || "normal",
        a.production_status || "non_production",
        toBoolean(a.customer_facing),
        // Metered spend stays off unless a ceiling is set; the plan is explicit.
        toBoolean(a.metered_spend_allowed) && Boolean(a.spend_ceiling_cents),
      ],
    );
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      // validSlug already rejects traversal; resolve and re-check so the mkdir
      // cannot escape its root even if the rule above is ever loosened.
      const root = WORKTREES_DIR;
      const worktree = path.resolve(root, a.slug);
      if (!worktree.startsWith(root + path.sep)) {
        return "refusing to create a worktree outside its root";
      }
      await fs.mkdir(worktree, { recursive: true, mode: 0o750 });
      await fs.mkdir(path.join(ARTIFACTS_DIR, inserted.rows[0].id), { recursive: true, mode: 0o750 });
      await fs.mkdir(path.join(BROWSERS_DIR, inserted.rows[0].id), { recursive: true, mode: 0o750 });
    } catch {
      /* ignore if permission or dir exists */
    }
    await pool.query(
      `UPDATE onboarding_sessions SET status = 'finalized', project_id = $2, updated_at = now() WHERE id = $1`,
      [sess.rows[0].id, inserted.rows[0].id],
    );
    await pool.query(
      `INSERT INTO audit_events (actor, action, target, project_id, metadata)
       VALUES ('supervisor', 'project.create', $1, $2, $3)`,
      [a.slug, inserted.rows[0].id, JSON.stringify({ name: a.name, type: a.project_type })],
    );
    return JSON.stringify({ project_id: inserted.rows[0].id, slug: a.slug });
  }
  if (name === "conversation.create") {
    let projectId: string | null = null;
    if (args.project_slug) {
      const p = await pool.query<{ id: string }>("SELECT id FROM projects WHERE slug = $1", [
        args.project_slug,
      ]);
      if (!p.rows[0]) return `no project with slug ${args.project_slug}`;
      projectId = p.rows[0].id;
    }
    const r = await pool.query<{ id: string }>(
      `INSERT INTO conversations (project_id, title, channel, created_from_inbox_id)
       VALUES ($1, $2, 'web', $3) RETURNING id`,
      [projectId, args.title || "New thread", inboxId],
    );
    return JSON.stringify({ conversation_id: r.rows[0].id, title: args.title });
  }
  if (name === "models.list") {
    // Jarvis answering questions about its own routing should read the registry,
    // not its training data — prices change, and the chain here is specific to
    // this box. Costs are month-to-date and measured, not estimated.
    // An unrecognised role used to filter everything out and return an empty
    // list, which reads as "nothing is configured" — and Jarvis duly reported
    // exactly that about a registry holding four healthy routes, after being
    // asked which was "primary". An empty result must never stand in for a bad
    // argument.
    const VALID_ROLES = [
      "supervisor", "utility", "senior_engineer", "reviewer",
      "stt", "voice_tts", "vision", "embeddings",
    ];
    const role = typeof args.role === "string" && args.role ? args.role : null;
    if (role && !VALID_ROLES.includes(role)) {
      return JSON.stringify({
        error: `no such role: ${role}`,
        valid_roles: VALID_ROLES,
        hint: "Route precedence is route_order, lowest first. Omit `role` to see every route.",
      });
    }
    const r = await pool.query(
      `SELECT m.provider, m.model_id, m.health, m.approval_state, m.route_order,
              m.role_assignments, m.open_weights, m.license,
              m.input_cost_per_mtok, m.output_cost_per_mtok,
              coalesce(sum(u.cost_usd), 0)::text AS month_spend_usd,
              count(u.*)::text                   AS month_calls
       FROM model_registry m
       LEFT JOIN model_usage u
         ON u.provider = m.provider AND u.model_id = m.model_id
        AND u.at >= date_trunc('month', now())
       WHERE m.approval_state = 'approved'
         AND ($1::text IS NULL OR $1 = ANY (m.role_assignments))
       GROUP BY m.id
       ORDER BY m.route_order`,
      [role],
    );
    const policy = await pool.query(
      `SELECT open_weights_only, monthly_ceiling_usd::text AS ceiling, autonomy
       FROM model_policy`,
    );
    return JSON.stringify({
      routes: r.rows,
      policy: policy.rows[0] ?? null,
      note: "input_cost_per_mtok / output_cost_per_mtok are USD per million tokens; null means unpriced, not free.",
    });
  }
  if (name === "connection.list") {
    const r = await pool.query(
      `SELECT c.slug, c.kind, c.scope, c.health, a.display_name, a.auth_type,
              (COALESCE(c.credential_id, a.credential_id) IS NOT NULL) AS connected
       FROM connections c
       LEFT JOIN auth_profiles a ON a.id = c.auth_profile_id
       ORDER BY c.slug`,
    );
    return JSON.stringify(r.rows);
  }
  if (name === "connection.request") {
    const profileId = args.profile_id ?? "";
    const prof = await pool.query<{ id: string; display_name: string; auth_type: string }>(
      `SELECT id, display_name, auth_type FROM auth_profiles WHERE id = $1`,
      [profileId],
    );
    if (!prof.rows[0]) return `no auth profile called ${profileId}`;
    const { ensureActionRequest } = await import("./actions.js");
    const { raiseIssue } = await import("./notify.js");
    const hostLogin = prof.rows[0].auth_type === "subscription_login";
    const raised = await raiseIssue(pool, {
      category: hostLogin ? "provider.cred_expired" : "setup.pending",
      service: profileId,
      owner: "user",
      status: "waiting_for_user",
      title: `[setup] ${prof.rows[0].display_name} not connected`,
      dedupeKey: `setup.request.${profileId}`,
      requiredAction: args.reason || `Connect ${prof.rows[0].display_name}.`,
    });
    if (!raised.issueId) return "could not open an issue";
    const made = await ensureActionRequest(pool, {
      issueId: raised.issueId,
      kind: hostLogin ? "host_login" : "provide_api_key",
      title: `Connect ${prof.rows[0].display_name}`,
      message: args.reason || `Jarvis needs ${prof.rows[0].display_name} to continue.`,
      profileId,
      connectionSlug: profileId,
    });
    return JSON.stringify({ action_request_id: made.id, opened: raised.created });
  }
  if (name === "issue.create") {
    if (!args.title?.trim()) return "title required";
    // The model supplies this string and it goes into a CHECK constraint, so an
    // out-of-range value used to abort the whole turn. Coerce instead.
    const allowed = ["critical", "high", "medium", "low"];
    const severity = allowed.includes((args.severity ?? "").toLowerCase())
      ? (args.severity as string).toLowerCase()
      : "medium";
    // Through raiseIssue so it dedupes and notifies like every other Issue.
    const { raiseIssue } = await import("./notify.js");
    const raised = await raiseIssue(pool, {
      category: "supervisor",
      service: "supervisor",
      owner: "user",
      status: "waiting_for_user",
      title: args.title.trim().slice(0, 200),
      dedupeKey: `supervisor.issue:${checksum(args.title.trim()).slice(0, 32)}`,
      evidence: { body: args.body ?? "" },
      severityOverride: severity as "critical" | "high" | "medium" | "low",
    });
    return JSON.stringify({ issue_id: raised.issueId, severity, created: raised.created });
  }
  // Surfaced rather than swallowed: a renamed or mistyped tool would otherwise
  // look to the model like a plain result and get reported as success.
  await pool.query(
    `INSERT INTO audit_events (actor, action, target, metadata)
     VALUES ('supervisor', 'supervisor.tool_unknown', $1, $2)`,
    [rawName, JSON.stringify({ resolved_to: name, conversation_id: conversationId })],
  ).catch(() => undefined);
  return `ERROR: no tool named ${rawName} exists. Do not claim the action succeeded.`;
}

type ProviderCandidate = {
  provider: string;
  url: string;
  model: string;
  key: string;
};

async function getProviderCandidates(
  pool: pg.Pool,
  role: ModelRole = "supervisor",
): Promise<ProviderCandidate[]> {
  // Routes come from model_registry, which only holds ids a live probe accepted.
  // Hardcoding ids here is what broke failover: every fallback 404'd.
  const routes = await routesForRole(pool, role);
  const keyCache = new Map<string, string | null>();
  const candidates: ProviderCandidate[] = [];
  for (const r of routes) {
    if (!keyCache.has(r.auth_profile_id)) {
      keyCache.set(r.auth_profile_id, await getProfileKey(pool, r.auth_profile_id));
    }
    const key = keyCache.get(r.auth_profile_id);
    if (!key) continue;
    candidates.push({ provider: r.provider, url: r.endpoint_url, model: r.model_id, key });
  }
  return candidates;
}

const RATE_LIMIT_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Last-resort Supervisor route: Claude on the operator's own subscription,
 * spoken to through the host CLI rather than an HTTP endpoint.
 *
 * INITIAL_MODEL_ROUTING names this as the final Supervisor fallback, but it is
 * NOT a peer of the others: the CLI has its own tool system and will not call
 * Jarvis's tools, so a turn served here can answer and cannot act. That is
 * exactly the confusion the rest of this system exists to prevent, so the route
 * runs with tools switched off and the reply says so in the text. It is reached
 * only when every HTTP candidate has failed.
 */
async function hostClaudeCompletion(
  pool: pg.Pool,
  messages: ChatMsg[],
  ctx: { conversationId: string; inboxId: string },
): Promise<ChatMsg | null> {
  const route = await pool.query<{ dir: string }>(
    `SELECT a.harness_auth_dir AS dir
     FROM model_registry m JOIN auth_profiles a ON a.id = m.auth_profile_id
     WHERE m.provider = 'anthropic' AND m.model_id = 'claude-sonnet-host'
       AND m.approval_state = 'approved' AND m.health = 'healthy'
       AND a.harness_auth_dir IS NOT NULL
     LIMIT 1`,
  );
  const dir = route.rows[0]?.dir;
  if (!dir) return null;

  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (typeof lastUser !== "string" || !lastUser.trim()) return null;

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  try {
    const { stdout } = await run(
      "claude",
      [
        "-p",
        lastUser,
        "--output-format",
        "json",
        // No tools at all. A partially-capable fallback that could touch some
        // tools but not Jarvis's would be worse than one that plainly cannot.
        "--allowedTools",
        "",
        "--append-system-prompt",
        `${typeof system === "string" ? system.slice(0, 4000) : ""}

`
          + "You are answering as a fallback with NO tools available. Do not say you "
          + "stored, created, scheduled or opened anything - you cannot. Say what you "
          + "would do and that it needs retrying when a tool-capable route is back. "
          + "You are a Claude model standing in for Jarvis, and Jarvis does not run on "
          + "Claude. Asked about models, routing, providers or prices, do NOT answer "
          + "from what you know about your own model family - that answer will be about "
          + "Anthropic's lineup and it will be wrong here. Say the registry has to be "
          + "read with the models_list tool and leave it there.",
      ],
      {
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    if (parsed.is_error || !parsed.result) return null;

    await pool
      .query(
        `INSERT INTO audit_events (actor, action, target, metadata)
         VALUES ('supervisor', 'supervisor.route', $1, $2)`,
        [
          "anthropic/claude-sonnet-host",
          JSON.stringify({
            conversation_id: ctx.conversationId,
            inbox_id: ctx.inboxId,
            provider: "anthropic",
            model: "claude-sonnet-host",
            transport: "host_cli",
            tools_available: false,
          }),
        ],
      )
      .catch(() => undefined);

    return {
      role: "assistant",
      content:
        `${parsed.result.trim()}

_(Answered by the subscription fallback, which has no tools. `
        + "Nothing was written or changed — ask again when a tool-capable route is available.)_",
    };
  } catch {
    return null;
  }
}

async function chatCompletionWithFailover(
  pool: pg.Pool,
  messages: ChatMsg[],
  ctx: { conversationId: string; inboxId: string; role?: ModelRole; brief?: boolean },
): Promise<ChatMsg> {
  const candidates = await getProviderCandidates(pool, ctx.role ?? "supervisor");
  if (!candidates.length) {
    throw new Error(
      "No usable Supervisor route in model_registry. Run catalog verification or add a provider key.",
    );
  }

  const errors: string[] = [];
  for (const [index, c] of candidates.entries()) {
    const isLastCandidate = index === candidates.length - 1;
    // Waiting out a 429 only makes sense when there is nothing else to try.
    // With a real multi-provider chain, moving on is faster than backing off,
    // and the caller is a person waiting on a reply.
    const maxAttempts = isLastCandidate ? RATE_LIMIT_RETRIES : 0;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      let detail = "";
      try {
        const res = await fetch(c.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${c.key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: c.model,
            messages,
            tools: ctx.brief ? PHONE_TOOLS : TOOLS,
            // A spoken turn does not need private deliberation. Measured on the
            // Fireworks route: 1608ms/78 output tokens with reasoning on, and
            // 492ms/16 with it off — most of a phone reply's latency was the
            // model thinking before saying one sentence. Trimming context alone
            // had made it worse (15s), because the reasoning scales with the
            // question, not the prompt.
            //
            // Only sent to Fireworks: it is the paid primary that serves nearly
            // every turn, and a provider that rejects an unknown field would be
            // marked failed and dropped out of the chain over a parameter.
            ...(ctx.brief && c.provider === "fireworks" ? { reasoning_effort: "none" } : {}),
            temperature: CHAT_TEMPERATURE,
            max_tokens: CHAT_MAX_TOKENS,
          }),
        });
        if (res.ok) {
          const json = (await res.json()) as {
            choices?: { message?: ChatMsg }[];
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
            };
          };
          const msg = json.choices?.[0]?.message;
          if (msg) {
            await markRouteHealth(pool, c.provider, c.model, "healthy", null);
            // Which route actually served the turn. FULL_LOOPS L4 step 2 requires
            // that the next turn uses the *next approved pair* when the primary
            // is unhealthy, and nothing recorded which pair answered — so that
            // step could not be checked, only assumed. `skipped` is how far down
            // the chain this route sat, which is the fall-through itself.
            await pool
              .query(
                `INSERT INTO audit_events (actor, action, target, metadata)
                 VALUES ('supervisor', 'supervisor.route', $1, $2)`,
                [
                  `${c.provider}/${c.model}`,
                  JSON.stringify({
                    conversation_id: ctx.conversationId,
                    inbox_id: ctx.inboxId,
                    provider: c.provider,
                    model: c.model,
                    skipped: index,
                    candidates: candidates.length,
                  }),
                ],
              )
              .catch(() => undefined);
            // What the turn actually cost. Every provider returns a usage
            // block and Jarvis was discarding all of it, so it could route
            // between models thirty times apart in price without knowing, and
            // nothing could answer what a month cost. Priced from the registry
            // at write time so a later price change cannot rewrite history.
            await pool
              .query(
                // Every parameter is cast at its first use. Without the casts
                // Postgres cannot infer $4/$5, which appear both as integer
                // columns and inside numeric arithmetic, and the whole insert
                // fails — silently, while the ledger stays empty.
                `INSERT INTO model_usage
                   (provider, model_id, role, conversation_id,
                    input_tokens, output_tokens, cached_tokens, cost_usd)
                 SELECT $1::text, $2::text, 'supervisor', $3::uuid,
                        $4::int, $5::int, $6::int,
                        round(($4::int::numeric / 1000000) * coalesce(m.input_cost_per_mtok, 0)
                            + ($5::int::numeric / 1000000) * coalesce(m.output_cost_per_mtok, 0), 6)
                 FROM model_registry m
                 WHERE m.provider = $1::text AND m.model_id = $2::text`,
                [
                  c.provider,
                  c.model,
                  ctx.conversationId,
                  json.usage?.prompt_tokens ?? 0,
                  json.usage?.completion_tokens ?? 0,
                  json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
                ],
              )
              // Not swallowed: this is the cost ledger, and an empty ledger that
              // never complains is exactly how it went unnoticed the first time.
              .catch((err) =>
                console.error("model_usage insert failed:", err instanceof Error ? err.message : err),
              );

            return msg;
          }
          detail = "empty choices";
        } else {
          // Keep the provider's own message: a bare status code hides "model retired".
          const body = (await res.text()).replace(/\s+/g, " ").slice(0, 300);
          detail = `HTTP ${res.status} ${body}`;
          if (res.status === 429 && attempt < maxAttempts) {
            const retryAfter = Number(res.headers.get("retry-after"));
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 8000)
              : 1200 * (attempt + 1);
            await sleep(waitMs);
            continue;
          }
        }
      } catch (err) {
        detail = err instanceof Error ? err.message : String(err);
      }
      errors.push(`${c.provider}/${c.model}: ${detail}`);
      await markRouteHealth(
        pool,
        c.provider,
        c.model,
        classifyRouteFailure(detail),
        detail,
      );
      break;
    }
  }

  // Every HTTP route is spent. Before giving up, try the subscription CLI —
  // text only, and it says so in its own reply. Persist-first already holds
  // either way; this is the difference between an answer and a 502.
  const hostReply = await hostClaudeCompletion(pool, messages, ctx).catch(() => null);
  if (hostReply) return hostReply;

  // Plan §74: exhausting the pool raises provider.degraded. It never turns on
  // metered spend — that stays an explicit decision by Enrique.
  await pool.query(
    `INSERT INTO issues (severity, category, service, status, owner, title, evidence,
                         required_action, dedupe_key)
     SELECT 'high', 'provider.degraded', 'models', 'open', 'jarvis',
            '[models] every approved Supervisor route failed', $1,
            'Check Models. Metered spend was NOT enabled; that stays your decision.',
            'provider.degraded.supervisor'
     WHERE NOT EXISTS (
       SELECT 1 FROM issues
       WHERE dedupe_key = 'provider.degraded.supervisor' AND status NOT IN ('resolved','ignored')
     )`,
    [JSON.stringify({ attempts: errors })],
  );
  throw new Error(`Supervisor failover exhausted: ${errors.join("; ")}`);
}

/**
 * One tool-less completion on the fastest healthy route.
 *
 * This is tier 1 of the call agent: no tools, no history, no memory injection,
 * reasoning off. Measured on Fireworks that configuration answers in 341-622ms
 * every time, where the same model with five tool schemas occasionally spent
 * 1.7s deciding which one to reach for. Nothing here may be added to without
 * re-measuring — the consistency IS the feature.
 */
export async function quickCompletion(
  pool: pg.Pool,
  system: string,
  user: string,
): Promise<string | null> {
  const candidates = await getProviderCandidates(pool, "supervisor");
  for (const c of candidates) {
    try {
      const res = await fetch(c.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: c.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.3,
          max_tokens: 200,
          ...(c.provider === "fireworks" ? { reasoning_effort: "none" } : {}),
        }),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = json.choices?.[0]?.message?.content;
      if (text) return text;
    } catch {
      /* try the next route */
    }
  }
  return null;
}


export async function runSupervisorTurn(
  pool: pg.Pool,
  args: {
    conversationId: string;
    inboxId: string;
    userText: string;
    payloadMode?: "full" | "metadata_only";
    projectName?: string | null;
    confidentiality?: string | null;
    /**
     * Which role's chain answers. The phone uses `utility` because a spoken turn
     * is latency-bound: measured on a live call the model was ~5.5s of a ~6.4s
     * wait, and a smaller model buys that back.
     */
    role?: ModelRole;
    /** Spoken turn: fewer tools, less history, a prompt written to be heard. */
    brief?: boolean;
  },
): Promise<string> {
  // SUPERVISOR.md prompt inputs: global memory always, plus this project's own
  // memory when the conversation is scoped. A project thread that cannot see its
  // own notes is why project answers read like generic advice.
  const conv = await pool.query<{ project_id: string | null }>(
    `SELECT project_id FROM conversations WHERE id = $1`,
    [args.conversationId],
  );
  const projectId = conv.rows[0]?.project_id ?? null;

  const mem = await pool.query<{ kind: string; body: string }>(
    `SELECT kind, body FROM memory_items
     WHERE project_id IS NULL OR ($1::uuid IS NOT NULL AND project_id = $1)
     ORDER BY (project_id IS NOT NULL) DESC, created_at DESC LIMIT 16`,
    [projectId],
  );

  let projectContext = "";
  if (projectId) {
    const proj = await pool.query<{
      name: string;
      slug: string;
      project_type: string;
      confidentiality: string;
      production_status: string;
      customer_facing: boolean;
      github_owner: string | null;
      github_repo: string | null;
      metered_spend_allowed: boolean;
    }>(
      `SELECT name, slug, project_type, confidentiality, production_status, customer_facing,
              github_owner, github_repo, metered_spend_allowed
       FROM projects WHERE id = $1`,
      [projectId],
    );
    const pr = proj.rows[0];
    if (pr) {
      const instructions = await pool.query<{ value: unknown }>(
        `SELECT value FROM config_versions
         WHERE project_id = $1 AND key = 'instructions'
         ORDER BY version DESC LIMIT 1`,
        [projectId],
      );
      projectContext = `
This conversation is scoped to the project ${pr.name} (${pr.slug}):
- type ${pr.project_type}, confidentiality ${pr.confidentiality}, ${pr.production_status.replace(/_/g, " ")}
- customer facing: ${pr.customer_facing ? "yes — always-confirm applies" : "no"}
- repository: ${pr.github_owner && pr.github_repo ? `${pr.github_owner}/${pr.github_repo}` : "not linked yet"}
- metered spend: ${pr.metered_spend_allowed ? "allowed" : "off"}
${instructions.rows[0] ? `- project instructions: ${JSON.stringify(instructions.rows[0].value).slice(0, 800)}` : ""}`;
    }
  }
  const recent = await pool.query(
    // Four exchanges is enough to hold a phone conversation together; twelve is
    // for a console thread being read back.
    `SELECT role, body FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [args.conversationId, args.brief ? 4 : 12],
  );
  const projects = await pool.query<{ slug: string; name: string; project_type: string }>(
    `SELECT slug, name, project_type FROM projects WHERE archived_at IS NULL ORDER BY name`,
  );
  const system = `You are Jarvis, Enrique's personal OS Supervisor, running on his own Netcup VPS.
Persist-first is already done: his message is stored before you are called, so never say it was lost.

How this system actually works — answer from these facts, never from generic internet advice:
- WhatsApp runs through OpenClaw on this VPS, paired by scanning a QR code with a normal WhatsApp account.
  There is NO paid WhatsApp Business API, no Twilio/360dialog/MessageBird. Never tell him to buy one.
- Third-party tools connect through the credential broker (Connections page) and, once he authorises it,
  Composio. The browser never receives raw secrets. Call connection.list before advising on any
  connection so you describe what is actually stored, not what you assume.
- Work runs as tasks in lanes (supervisor, heavy, system) and is visible in the Control Center under Work and Queue.
- Anything you cannot do yourself becomes an Issue with issue.create, so it shows on the Issues page.
- Conversations are threads. Use conversation.create to open a new thread, optionally inside a project.

Rules:
- Use tools for memory, threads and project creation. Do not claim you created a project or thread
  unless the tool call actually returned success.
- Seeing an earlier identical request in this thread does not satisfy a new one. If he asks again,
  call the tool again — memory_upsert is idempotent. Never answer "Stored" from history alone.
- A professional project must answer confidentiality, production_status, customer_facing and
  metered_spend_allowed before onboarding_finalize will create it. Ask for them.
- If something is blocked on a credential Enrique has not provided, call connection.request.
  It opens an action page he can complete. Never tell him to edit files or paste keys into chat.
- GitHub is optional. Metered spend stays off unless he sets a ceiling.
- Be concise and concrete. Say what you did, what is blocked, and what you need from him.

${projectContext}
Projects that exist right now:
${projects.rows.map((p) => `- ${p.name} (${p.slug}, ${p.project_type})`).join("\n") || "(none)"}

Known global memory:
${mem.rows.map((m) => `- [${m.kind}] ${m.body}`).join("\n") || "(none)"}`;

  // ADR 005: for a confidential project the model sees metadata, never the body —
  // including in the recent-history window, which would otherwise leak it anyway.
  const redacted = args.payloadMode === "metadata_only";
  const userPayload = redacted
    ? metadataOnlyPayload({
        projectId: projectId,
        projectName: args.projectName ?? null,
        confidentiality: args.confidentiality ?? null,
        channel: "web",
        sender: "enrique",
        occurredAt: new Date().toISOString(),
        text: args.userText,
      })
    : args.userText;

  // The window is 12 messages but each body is unbounded, so one pasted log or
  // stack trace inflates every following turn until it falls out of the window.
  // That is both a cost path (free-tier daily token limits are what actually
  // takes the Supervisor down) and a context-overflow path. Older turns only
  // need to carry the thread of the conversation, so they are capped; the
  // message being answered is passed in full below.
  const HISTORY_CHARS = 2000;
  const trimForHistory = (body: string) =>
    body.length <= HISTORY_CHARS
      ? body
      : `${body.slice(0, HISTORY_CHARS)}
[... ${body.length - HISTORY_CHARS} more characters trimmed from this earlier message]`;

  const history = redacted
    ? []
    : recent.rows
        .reverse()
        .map((m) => ({
          role: m.role === "jarvis" ? "assistant" : m.role,
          content: trimForHistory(m.body),
        }));

  // The full prompt explains the whole system: WhatsApp routing, the credential
  // broker, project onboarding rules. None of it belongs in a spoken turn, and
  // all of it is paid for on every round trip.
  const spokenSystem =
    `You are Jarvis, Enrique's personal operations assistant, speaking to him on the phone.
`
    + `Answer in ONE short sentence — it is read aloud. No lists, no markdown, no preamble.
`
    + `You may call him "sir" occasionally, never twice in a reply.
`
    + `Use a tool when one fits; never claim you did something unless the tool returned success.
`
    + `This channel cannot authorise a destructive or always-confirm action: say it needs `
    + `confirming in the Control Center.

`
    + `Known memory:\n${mem.rows.map((m) => `- ${m.body}`).join("\n") || "(none)"}`;

  const messages: ChatMsg[] = [
    { role: "system", content: args.brief ? spokenSystem : system },
    ...history,
  ];
  if (!messages.some((m) => m.role === "user" && m.content === userPayload)) {
    messages.push({ role: "user", content: userPayload });
  }

  let toolsRan = 0;

  for (let i = 0; i < 8; i++) {
    const msg = await chatCompletionWithFailover(pool, messages, {
      conversationId: args.conversationId,
      inboxId: args.inboxId,
      role: args.role,
      brief: args.brief,
    });
    const calls = (msg.tool_calls ?? []) as {
      id: string;
      function: { name: string; arguments: string };
    }[];
    if (!calls.length) {
      const text = (msg.content ?? "").trim() || "(no reply)";
      if (toolsRan === 0 && claimsAnAction(text)) {
        await pool
          .query(
            `INSERT INTO audit_events (actor, action, target, metadata)
             VALUES ('supervisor', 'supervisor.unverified_claim', NULL, $1)`,
            [
              JSON.stringify({
                conversation_id: args.conversationId,
                inbox_id: args.inboxId,
                reply_prefix: text.slice(0, 120),
              }),
            ],
          )
          .catch(() => undefined);
      }
      return text;
    }
    messages.push(assistantForHistory(msg));
    for (const call of calls) {
      let parsed: Record<string, string> = {};
      try {
        parsed = JSON.parse(call.function.arguments || "{}") as Record<string, string>;
      } catch {
        parsed = {};
      }
      const result = await runTool(pool, args.conversationId, args.inboxId, call.function.name, parsed);
      toolsRan += 1;
      // Every Supervisor tool call is recorded. Without this there is no way to
      // tell a turn that used a tool from one that only claimed to — which is
      // exactly the failure the prompt forbids and nothing could detect.
      await pool.query(
        `INSERT INTO audit_events (actor, action, target, metadata)
         VALUES ('supervisor', 'supervisor.tool', $1, $2)`,
        [
          call.function.name,
          JSON.stringify({
            conversation_id: args.conversationId,
            inbox_id: args.inboxId,
            // Arguments can carry pasted content, so only their shape is kept.
            arg_keys: Object.keys(parsed).sort(),
            result: result.slice(0, 200),
          }),
        ],
      ).catch(() => undefined);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: result,
      });
    }
  }
  return "I hit the tool-call limit. Try again with a smaller ask.";
}

export function checksum(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

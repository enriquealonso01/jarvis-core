import type pg from "pg";
import { ensureActionRequest, type ActionKind } from "./actions.js";
import { enqueueNotification } from "./notify.js";

const HOST_LOGIN = ["anthropic_personal", "openai_codex_personal", "cursor_personal"];
const OAUTH = ["netcup_scp"];

export async function ensureBlockedIssues(pool: pg.Pool): Promise<void> {
  for (const id of HOST_LOGIN) {
    await pool.query(
      `INSERT INTO issues (severity, category, service, status, owner, title, required_action, dedupe_key)
       SELECT 'medium', 'provider.cred_expired', $1, 'waiting_for_user', 'user',
              $2, 'Host login on the VPS (ADR 006). Not an API key.', $3
       WHERE NOT EXISTS (
         SELECT 1 FROM auth_profiles WHERE id = $1 AND (credential_id IS NOT NULL OR harness_auth_dir IS NOT NULL)
       ) AND NOT EXISTS (
         SELECT 1 FROM issues WHERE dedupe_key = $3 AND status NOT IN ('resolved', 'ignored')
       )`,
      [id, `[setup] ${id} host login not connected`, `setup.login.${id}`],
    );
  }
  for (const id of OAUTH) {
    await pool.query(
      `INSERT INTO issues (severity, category, service, status, owner, title, required_action, dedupe_key)
       SELECT 'low', 'oauth.expired', $1, 'waiting_for_user', 'user',
              $2, 'OAuth refresh token from Netcup SCP when ready.', $3
       WHERE NOT EXISTS (
         SELECT 1 FROM auth_profiles WHERE id = $1 AND credential_id IS NOT NULL
       ) AND NOT EXISTS (
         SELECT 1 FROM issues WHERE dedupe_key = $3 AND status NOT IN ('resolved', 'ignored')
       )`,
      [id, `[setup] ${id} OAuth not connected`, `setup.oauth.${id}`],
    );
  }
  await pool.query(
    `INSERT INTO issues (severity, category, service, status, owner, title, required_action, dedupe_key)
     SELECT 'medium', 'config.drift', 'openclaw', 'waiting_for_user', 'user',
            '[setup] WhatsApp dedicated number + QR pairing not done',
            'Phase 2: dedicated WhatsApp, allowlist, QR via Tailscale/SSH.',
            'setup.whatsapp'
     WHERE NOT EXISTS (
       SELECT 1 FROM channel_allowlist WHERE channel = 'whatsapp'
     ) AND NOT EXISTS (
       SELECT 1 FROM issues WHERE dedupe_key = 'setup.whatsapp' AND status NOT IN ('resolved', 'ignored')
     )`,
  );
  await pool.query(
    `INSERT INTO issues (severity, category, service, status, owner, title, required_action, dedupe_key)
     SELECT 'medium', 'provider.cred_expired', 'telnyx', 'waiting_for_user', 'user',
            '[setup] Telnyx E.164 numbers not configured',
            'Provide inbound/outbound numbers; ElevenLabs voice_id in site.yaml.',
            'setup.telnyx'
     WHERE NOT EXISTS (
       SELECT 1 FROM channel_allowlist WHERE channel = 'phone'
     ) AND NOT EXISTS (
       SELECT 1 FROM issues WHERE dedupe_key = 'setup.telnyx' AND status NOT IN ('resolved', 'ignored')
     )`,
  );
}

/**
 * Close a setup blocker once the thing it was waiting for has arrived.
 *
 * `ensureBlockedIssues` only ever guarded against RE-raising: once open, an
 * issue stayed open forever, and the console kept showing "[setup] Composio not
 * connected" months after composio was connected, healthy, and in use. A banner
 * that is wrong is worse than no banner, because it teaches the reader to ignore
 * the row of them.
 *
 * Each gap is closed by the condition that would have raised it, asked freshly —
 * not by a flag someone remembered to set.
 */
export async function resolveSatisfiedBlockers(pool: pg.Pool): Promise<string[]> {
  const closed: string[] = [];
  const gaps: { dedupe: string; satisfied: string; params?: unknown[] }[] = [
    ...HOST_LOGIN.map((id) => ({
      dedupe: `setup.login.${id}`,
      satisfied:
        `SELECT 1 FROM auth_profiles WHERE id = '${id}'
           AND (credential_id IS NOT NULL OR harness_auth_dir IS NOT NULL)`,
    })),
    ...OAUTH.map((id) => ({
      dedupe: `setup.oauth.${id}`,
      satisfied: `SELECT 1 FROM auth_profiles WHERE id = '${id}' AND credential_id IS NOT NULL`,
    })),
    {
      // Composio is connected when it has a credential and is not unhealthy.
      dedupe: "setup.composio",
      satisfied:
        `SELECT 1 FROM auth_profiles WHERE id = 'composio' AND credential_id IS NOT NULL
           AND health <> 'down'`,
    },
    {
      /*
       * The phone is configured when Telnyx has a credential and a number is
       * pinned. The original condition asked `channel_allowlist` — which the
       * phone path never reads; it reads `site.yaml` — so the row stayed open
       * through every working call.
       */
      dedupe: "setup.telnyx",
      satisfied: `SELECT 1 FROM auth_profiles WHERE id = 'telnyx' AND credential_id IS NOT NULL`,
    },
    {
      dedupe: "setup.whatsapp",
      satisfied: `SELECT 1 FROM channel_allowlist WHERE channel = 'whatsapp'`,
    },
  ];

  for (const gap of gaps) {
    const done = await pool.query(gap.satisfied).catch(() => ({ rowCount: 0 }));
    if (!done.rowCount) continue;
    const r = await pool.query(
      `UPDATE issues SET status = 'resolved', resolved_at = now(), updated_at = now()
       WHERE dedupe_key = $1 AND status NOT IN ('resolved', 'ignored')`,
      [gap.dedupe],
    );
    if (r.rowCount) closed.push(gap.dedupe);
  }
  return closed;
}

/**
 * An Issue that says "paste a key" is not actionable until there is somewhere to
 * paste it. Every open setup blocker gets a linked action request so the console
 * can send Enrique straight to the thing that unblocks it.
 */
const SETUP_ACTIONS: {
  dedupe: string;
  kind: ActionKind;
  title: string;
  message: string;
  profileId?: string;
  connectionSlug?: string;
}[] = [
  {
    dedupe: "setup.composio",
    kind: "provide_api_key",
    title: "Connect Composio",
    message:
      "Paste the Composio API key. Jarvis stores it encrypted on the server and uses it to reach the toolkits you allow — it never returns the key to the browser.",
    profileId: "composio",
    connectionSlug: "composio",
  },
  {
    dedupe: "setup.oauth.netcup_scp",
    kind: "oauth_connect",
    title: "Connect Netcup SCP",
    message:
      "Paste the SCP OAuth refresh token so Jarvis can see and operate its own server. Ordering and billing stay always-confirm.",
    profileId: "netcup_scp",
    connectionSlug: "netcup_scp",
  },
  {
    dedupe: "setup.login.anthropic_personal",
    kind: "host_login",
    title: "Anthropic host login",
    message:
      "This is a subscription login, not an API key: run the Anthropic CLI login on the VPS. There is nothing to paste here.",
    profileId: "anthropic_personal",
  },
  {
    dedupe: "setup.login.openai_codex_personal",
    kind: "host_login",
    title: "Codex host login",
    message:
      "Run the Codex/ChatGPT CLI login on the VPS. Subscription login, not an API key.",
    profileId: "openai_codex_personal",
  },
  {
    dedupe: "setup.login.cursor_personal",
    kind: "host_login",
    title: "Cursor host login",
    message: "Run the Cursor ACP login on the VPS. Subscription login, not an API key.",
    profileId: "cursor_personal",
  },
  {
    dedupe: "setup.whatsapp",
    kind: "pair_channel",
    title: "Pair WhatsApp",
    message:
      "On the VPS: docker compose --profile openclaw up -d, then open the OpenClaw QR through the Tailscale tunnel and scan it with the WhatsApp account Jarvis should use. No paid WhatsApp Business API is involved.",
  },
  {
    dedupe: "setup.telnyx",
    kind: "provide_config",
    title: "Configure Telnyx numbers",
    message:
      "Add the inbound/outbound E.164 numbers and the ElevenLabs voice_id to site.yaml on the VPS.",
  },
];

export async function ensureActionRequests(pool: pg.Pool): Promise<void> {
  for (const a of SETUP_ACTIONS) {
    const issue = await pool.query<{ id: string }>(
      `SELECT id FROM issues
       WHERE dedupe_key = $1 AND status NOT IN ('resolved', 'ignored')
       ORDER BY created_at DESC LIMIT 1`,
      [a.dedupe],
    );
    if (!issue.rows[0]) continue;
    const made = await ensureActionRequest(pool, {
      issueId: issue.rows[0].id,
      kind: a.kind,
      title: a.title,
      message: a.message,
      profileId: a.profileId,
      connectionSlug: a.connectionSlug,
      // Setup blockers are standing work, not a link mailed out for one action:
      // they live in the console behind a session, so a 2-hour token would only
      // mean re-minting on every visit. The token still expires.
      ttlHours: 24 * 30,
    });
    // A setup blocker is worth exactly one message, keyed so restarts and
    // repeated boots cannot turn it into a stream (plan §17.5).
    await enqueueNotification(pool, {
      level: "whatsapp_blocker",
      messageType: "blocker",
      body: `${a.title}: ${a.message}`,
      objectType: "action_request",
      objectId: made.id,
      idempotencyKey: `blocker:${a.dedupe}`,
    });
  }
}

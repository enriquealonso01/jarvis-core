# ADR 004 — Single-user authentication and Control Center hosting

- Status: accepted
- Date: 2026-08-31
- Plan sections: §2.2, §12, §38, §44, §83
- Affects isolation / billing / always-confirm: no

## Decision

Jarvis has **one human user**. There is no org, no roles matrix, no OAuth login to Jarvis itself.

**User record:** email, argon2id password hash, created at bootstrap. Password is the only interactive login in V1. Passkeys may be added later via ADR; not required to launch.

**Session:** 32-byte random token, stored hashed in `sessions`. HttpOnly, Secure, SameSite=Lax cookie `jarvis_session`. Idle sliding 30 days, absolute 90 days. Logout deletes the row.

**Same-origin production (normative):**

Netlify hosting a SPA on another site than the API makes cookie auth fragile (SameSite=None, CSRF, stolen Bearer in localStorage). V1 production therefore serves the Control Center **and** the API on one origin:

- Public hostname: `https://jarvis.<domain>` (filled in `config/site.yaml`)
- Caddy on Netcup: `/api/*` → Jarvis API; `/` → Control Center static build; `/webhooks/telnyx` → API
- Netlify remains **preview hosting** for `jarvis-control-center` PRs (plan §2.2, §57). Preview deploys authenticate with the same cookie scheme only if preview is not used against production; default preview talks to a non-production API or is Tailscale-only.

Optional later: Netlify production with `/api` proxy to Netcup. That is equivalent same-origin. Do not ship a cross-site Bearer-in-localStorage Control Center as production.

**WhatsApp / phone action links (§12):**

- URL: `https://jarvis.<domain>/actions/<request_id>?t=<single_use_token>`
- Token: 32 bytes, hashed at rest, TTL 2 hours, one successful consume
- If no session: login page, then resume consume
- Token is not a secret-export; it only opens that UserActionRequest
- Used token replay → 409, Issue category `security` if repeated
- Secrets POST to `https://jarvis.<domain>/api/action-requests/:id/submit` (Netcup), never to Netlify functions

**Not auth:**

- Caller ID
- WhatsApp sender (allowlist is **authorization to talk**, then still bound to the one user account for command authority; unknown senders never get pairing auto-approval)
- OpenClaw Gateway token (never in the browser)

**API CSRF:** Same-site cookie + `Origin`/`Referer` check on mutating routes + same-origin. Internal ingest uses HMAC, not the user cookie.

**Lockout:** 10 failed logins in 15 minutes → 15 minute cooldown, health incident if it continues (single-user brute force).

## Why

The plan requires authenticated Control Center and expiring action pages, and forbids secrets in Netlify. It does not specify cookies vs JWT. Same-origin cookie is the smallest thing that works for one user.

## Alternatives rejected

- **Tailscale-only Control Center** — WhatsApp deep links must work on the phone’s LTE without Tailscale. Public HTTPS UI is required. OpenClaw **admin** stays Tailscale-only (ADR 009).
- **Magic-link only** — no mailer in V1 as a required dependency. Password at bootstrap is enough.
- **Multi-user JWT/OAuth** — out of scope.

## Consequences

- Domain must be chosen at Phase 0 (`config/site.yaml`).
- Control Center env: production `API` is relative `/api`.
- §83 inspects cookies: session cookie is opaque, not a provider secret.
- **Rollback:** adding a second human user means sessions, grants, audit actor, and every `requireUser` call gain an identity dimension. Splitting the origin again reintroduces the SameSite/CSRF problem this ADR exists to avoid, and would need Bearer auth end to end.

## User approval required

No for the mechanism. Yes for the actual domain name at bootstrap (config, not architecture).

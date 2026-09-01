# ADR 014 — Netcup is the only machine; bootstrap all declared providers

- Status: accepted
- Date: 2026-08-31
- Plan sections: §2.1, §35, §63, ADR 013
- Affects isolation / billing / always-confirm: no
- User approval: yes (this conversation)
- Supersedes: ADR 013 local-first / laptop Compose as the build environment

## Decision

**Nothing is developed or run as the Jarvis environment on Enrique’s laptop.** The Netcup VPS is the only Jarvis host: build, bootstrap, chat, workers, OpenClaw, backups. A laptop is only an SSH/Tailscale client and a browser to the Control Center.

ADR 013 still applies for: first *product* loop (talk, remember, create project), Supervisor tools, Fastify/Next/Tailwind, chat blocked until a Supervisor route is healthy. It does **not** apply for “code locally then promote.”

**Phase 0 happens first** on Netcup: provision, harden, DNS, TLS, Tailscale, disk layout, Compose on that box, restic/B2.

**Bootstrap includes every provider the plan already declared**, not a single Groq key. The operator submits credentials once (Control Center setup / UserActionRequests / bootstrap CLI). Missing optional later items (Telnyx) can wait for Phase 5; **model providers in §35 are not optional for bootstrap.**

Metered spend remains **default off**. Connecting a key is not enabling pay-as-you-go. If a provider will not run without billing, the profile stays `waiting` and an Issue asks for an explicit ceiling — do not silently turn on paid APIs.

Subscription harnesses (Claude Code, Codex, Cursor) are **logins on the Netcup host** per ADR 006, not API keys in the broker. API-key providers (Groq, NVIDIA, Google, ElevenLabs) are broker ciphertext.

Exact model IDs are verified against live catalogs at bootstrap and written into `model_registry`. The **recommended initial routes** are `docs/INITIAL_MODEL_ROUTING.md` (from plan §35). Improvement may change routes later with approval if trust/billing changes.

## Why

The operator was explicit: the OS lives on another machine. The plan already named Groq, NVIDIA, Google, Anthropic, Codex, Cursor, ElevenLabs, and Whisper. Asking for “one key to start” was under-scoping setup.

## Alternatives rejected

- **Laptop Compose as Jarvis** — rejected by the operator.
- **Connect providers later in chat** — rejected; setup provides the keys.
- **Enable all metered APIs at bootstrap** — forbidden by §37.

## Consequences

- FIRST_SLICE and PHASE_CHECKLIST run on Netcup.
- Control Center first-run is a **provider checklist**, then chat.
- No `NODE_ENV=development` cookie exceptions as the real environment. Local HTTP cookie rules are gone.
- **Rollback:** developing on the laptop again would need a second environment with its own cookie, TLS, and credential rules — the exact split this ADR removes. Deferring a §35 provider is reversible (the profile stays `waiting`); turning on metered spend is not reversible without a billing conversation.

## User approval required

Yes — given.

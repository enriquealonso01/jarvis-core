# First vertical slice

> **SUPERSEDED by `JARVIS_MASTER_PLAN_V2.md`. Do not build from this file.**
>
> This is the document that put worktrees, GitHub keys and harness spawn out of
> scope — the deferral that left v1 with a chassis and no engine.
> `GAP_ANALYSIS.md` is the post-mortem. Kept because the failure is more
> instructive than the plan was.

Runs **on Netcup only** (ADR 014). Laptop is SSH/Tailscale/browser.

Build this **before** WhatsApp, Telnyx, and coding harnesses. Do **not** skip provider bootstrap.

## In

- Phase 0 on Netcup: harden, Tailscale, DNS, Caddy, `/var/lib/jarvis`, Compose, restic/B2
- `jarvis-core` TypeScript (Fastify, `pg`, SQL migrations, pnpm)
- Control Center (Next.js App Router, Tailwind)
- Bootstrap: user, master key, migrate, seed Improvement + Maintenance + global conversation
- **Collect every bootstrap profile** in `docs/INITIAL_MODEL_ROUTING.md` (Groq, NVIDIA, Google, Anthropic login, Codex login, Cursor login, ElevenLabs, GitHub admin, B2)
- Verify live model catalogs; write `model_registry` routes from that doc
- Global chat: paste docs → `memory.upsert`; create project via onboarding tools
- Persist-before-model

## Out (later, already specified)

- OpenClaw / WhatsApp
- Phone / Telnyx (ElevenLabs key is collected now; calling waits)
- GitHub deploy keys, worktrees, ACP harnesses (logins collected now; spawn waits)
- Netlify broker
- Improvement weekly worker (project+schedule exist)

## Exit test (human, against `https://jarvis.<domain>`)

1. SSH/Tailscale to Netcup; stack healthy; login on the Control Center.
2. Setup checklist shows Groq, NVIDIA, Google, Anthropic, Codex, Cursor, ElevenLabs connected (or explicit Issue if a catalog check failed).
3. Paste a chunk of the Jarvis plan in Home chat. Ask Jarvis to remember it.
4. Reboot the VPS. Ask “what did I tell you about Improvement?” — it knows.
5. “Create a personal project called Alpha, not customer facing, no GitHub yet.”
6. Projects list shows Alpha + Improvement + Maintenance.

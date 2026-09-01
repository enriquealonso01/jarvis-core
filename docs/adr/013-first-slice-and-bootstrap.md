# ADR 013 — First vertical slice and bootstrap so chat works

- Status: accepted; **hosting clause superseded by ADR 014**
- Date: 2026-08-31
- Plan sections: §15, §31–35, §63–66, L0
- Affects isolation / billing / always-confirm: no

## Decision

We are ready to **write code**, not to implement every phase in one throw. The first shippable slice is **talk + remember + create a project**. WhatsApp, phone, and coding harnesses come after that slice works **on Netcup** (ADR 014).

### Slice A — Talk (must work before harnesses/phone)

On the Netcup Compose stack: Postgres, API, Control Center. Login. Global Supervisor conversation. Persist-before-model. SSE replies.

**Bootstrap collects every §35 provider** (ADR 014, `INITIAL_MODEL_ROUTING.md`). Chat is disabled until the Supervisor **route** is healthy (primary or fallback). First-run Home is a provider checklist, then the composer.

### Slice B — Remember and create projects (same slice, not Phase 4)

Pasted documentation becomes `memory_items` with `project_id` null (global). “Create a project” uses `onboarding_sessions` and TEMPLATES. GitHub repo may be deferred.

Phase 4 remains: deploy keys, harnesses, PRs, Netlify broker.

### Supervisor turn loop (Jarvis, not OpenClaw)

After Inbox persist:

1. Route (ADR 005). Global if no project.
2. If no healthy Supervisor route → Issue; UI blocked compose.
3. Call the model via Jarvis model router. OpenClaw does **not** complete this turn.
4. Model may call **only** the Supervisor tool catalog (`docs/SUPERVISOR.md`).
5. Persist assistant message + tool results. SSE `conversation.message`.

OpenClaw is not required for Slice A.

### Stack

- API: Fastify on Node 22, `pg`, raw SQL migrations, pnpm
- Control Center: Next.js App Router, TypeScript, Tailwind
- Host: Netcup only (ADR 014). Caddy same-origin (ADR 004).

## Why

The plan’s Phase 3 vs Phase 4 split put “create project from chat” after engineering. The operator’s first loop is chat, then projects.

## Alternatives rejected

- **Fake Supervisor replies without a model** — not Jarvis.
- **Require GitHub before a project row exists** — blocks “start empty and grow.”
- **Laptop as the Jarvis host** — superseded; see ADR 014.

## Consequences

- Slice A/B exit is L0 on Netcup, not L0b (PR).
- Control Center may start as `apps/control-center` in Core until the second GitHub repo exists; split before calling the frontend a separate production project.
- **Rollback:** the slice boundary is a sequencing decision, so reversing it costs nothing already built. Moving Control Center out of Core later is a repo split; leaving it inside Core past the point where the frontend is called a separate production project is the change that is hard to undo.

## User approval required

Hosting: see ADR 014.

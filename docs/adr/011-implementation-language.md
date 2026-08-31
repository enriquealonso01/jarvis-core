# ADR 011 — Implementation language and migration style

- Status: accepted
- Date: 2026-08-31
- Plan sections: §5.1, §3 (OpenClaw plugin)
- Affects isolation / billing / always-confirm: no

## Decision

**Jarvis Core API, workers, broker, and `jarvis-bridge` are TypeScript on Node 22.** OpenClaw plugins are JavaScript/TypeScript; keeping one language avoids a bridge-in-TS / API-in-Python split.

**Control Center** remains Next.js/React in `jarvis-control-center` (plan §2.2).

**Schema migrations** are numbered raw SQL files in `jarvis-core/migrations/`. No ORM as the source of truth. A thin `pg` (or equivalent) query layer is fine. Drizzle/Prisma may be added later only as a consumer of the same SQL, not a second schema.

**Package manager:** `pnpm` (OpenClaw ecosystem). Pin versions.

Python is not forbidden for one-off Maintenance scripts, but the control plane is TypeScript.

## Why

The plan did not pick a language. That is how repos grow two APIs.

## Alternatives rejected

- **Python FastAPI + TS plugin** — workable, worse for one operator.
- **Go API** — extra language for no V1 need.

## Consequences

- `package.json` at Core root; `packages/openclaw-jarvis-bridge`, `packages/integrations`.
- Do not start a Django app for Jarvis.

## User approval required

No, unless Enrique prefers Python for the API — then supersede this ADR before Phase 1 code.

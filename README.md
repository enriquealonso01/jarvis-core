# Jarvis Core

Private control plane for Jarvis V1: API, policy, Inbox, queue, broker, and OpenClaw integration.

This repository is the source of truth for **what to build** and **how it is wired**. Product decisions live in the current master plan (`JARVIS_MASTER_PLAN_V2.md`, which supersedes the frozen v1.2). Implementation mechanics live in the contract and ADRs. Do not invent product features during implementation.

## Read in this order

1. [`docs/README.md`](docs/README.md) — document map
2. [`docs/JARVIS_MASTER_PLAN_V2.md`](docs/JARVIS_MASTER_PLAN_V2.md) — current product
3. [`docs/IMPLEMENTATION_CONTRACT.md`](docs/IMPLEMENTATION_CONTRACT.md) — how every plan section is built
4. [`AGENTS.md`](AGENTS.md) — rules for implementation agents

Companion frontend: `jarvis-control-center` (separate private repository).

## Running it locally

No Claude subscription, no Linux box, no `/var/lib/jarvis` required (plan S1).

```
pnpm dev:up      # postgres + api, migrations applied
pnpm dev:seed    # operator dev@jarvis.local / dev-password-1234, a throwaway repo
pnpm dev:test    # drive every fake-harness variant through the real runner
pnpm dev:down    # and forget all of it
```

`JARVIS_HARNESS=fake[:variant]` makes the runner spawn `scripts/fake-harness.mjs`
instead of `claude`. Variants: `ok`, `crash`, `slow`, `runaway`, `noop`,
`escape`, `probe`, `repeat`, `context`, `errorresult`, `errortool`,
`echoprompt`, `fixtest`, `fail`, and `workflow[:mode]` (the S6 engineering
loop; see the header of `scripts/fake-harness.mjs` for the full list and what
each one exercises).

`JARVIS_MODEL=fake` swaps the provider chain for a scripted stand-in
(`src/fakemodel.ts` + `scripts/fixtures/*.json`) so a Supervisor turn completes
with no credential and no network:

```
JARVIS_MODEL=fake pnpm dev:up
pnpm dev:seed
bash scripts/s2-task-create-test.sh
```

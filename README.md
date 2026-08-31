# Jarvis Core

Private control plane for Jarvis V1: API, policy, Inbox, queue, broker, and OpenClaw integration.

This repository is the source of truth for **what to build** and **how it is wired**. Product decisions live in the current master plan (v1.2). Implementation mechanics live in the contract and ADRs. Do not invent product features during implementation.

## Read in this order

1. [`docs/README.md`](docs/README.md) — document map
2. [`docs/JARVIS_V1_MASTER_PLAN_v1.2.md`](docs/JARVIS_V1_MASTER_PLAN_v1.2.md) — current product
3. [`docs/IMPLEMENTATION_CONTRACT.md`](docs/IMPLEMENTATION_CONTRACT.md) — how every plan section is built
4. [`AGENTS.md`](AGENTS.md) — rules for implementation agents

Companion frontend: `jarvis-control-center` (separate private repository).

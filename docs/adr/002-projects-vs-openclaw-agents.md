# ADR 002 — Jarvis projects vs OpenClaw agents

- Status: accepted
- Date: 2026-08-31
- Plan sections: §3, §5, §7, OpenClaw multi-agent docs
- Affects isolation / billing / always-confirm: no (prevents an isolation bug)

## Decision

V1 uses **one** OpenClaw agent: `jarvis-supervisor`.

A Jarvis **project** is not an OpenClaw agent. Projects are Postgres rows plus:

- a worktree directory (when engineering starts)
- a browser profile directory
- secret namespace
- connection allowlist
- model-auth-profile allowlist

Heavy work runs as Jarvis-managed processes (Docker sandbox and/or ACP harness) with project mounts. They are linked to the task via `external_id`.

At boot, only `jarvis-improvement` and `jarvis-maintenance` exist as projects (ADR 012). Further projects are created through chat.

**OpenClaw OAuth read-through must not exist across Jarvis auth profiles.** OpenClaw will reuse the main agent's credential for the same profile id on secondary agents. That is one reason V1 does not create an OpenClaw agent per Jarvis project.

Project-owned provider credentials (when a professional project adds them) are **never** stored in the Supervisor OpenClaw auth store. They live only under `/var/lib/jarvis/harness-auth/<profile_id>/` and in the credential broker ciphertext table.

## Why

OpenClaw “agents” are personas with workspaces and SQLite. Jarvis “projects” are security boundaries. Mapping 1:1 would look tidy and then leak OAuth across projects.

## Alternatives rejected

- **One OpenClaw agent per Jarvis project** — OAuth read-through, ACP host auth, and WhatsApp binding become a confidentiality incident.
- **Two OpenClaw agents (personal vs professional)** — WhatsApp is one number; inbound still needs Jarvis routing.

## Consequences

- WhatsApp allowlist and pairing live on the single Supervisor agent.
- Project isolation is enforced by Jarvis (sandbox mounts, broker, profile dirs), not by OpenClaw workspace paths.
- Do not treat `~/.openclaw/workspace` as a project boundary (plan §7 already said this).

## User approval required

No.

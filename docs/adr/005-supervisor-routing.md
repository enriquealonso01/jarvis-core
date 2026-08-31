# ADR 005 — Supervisor routing and confidential redaction

- Status: accepted
- Date: 2026-08-31
- Plan sections: §7.1, §15, §28.2, §31, §80.1
- Affects isolation / billing / always-confirm: yes (enforces confidential-project model policy)

## Decision

Classification is a **pipeline**. An LLM is never the first reader of a confidential body.

**Stage A — persist.** Inbox Event written. No model.

**Stage B — deterministic router (no LLM).** Assign project and conversation when any of these hit, in order:

1. Explicit user correction stored on the event (UI “wrong project”).
2. In-message project directive: `#project-slug` or exact configured aliases.
3. Reply/thread pointer to an existing conversation (`in_reply_to` / quoted WhatsApp / UI thread id).
4. Correlation window: same channel, same sender, last event < 10 minutes, that conversation’s project still exists, and the new text does not name a different project slug/alias.
5. Sticky UI “active project” if set and not older than 2 hours.
6. Allowlisted sender bound to one project (optional; default off).
7. **Else: global Supervisor conversation** (no application project). This is the first-run path.

If Stage B assigns `confidentiality` in {confidential, restricted}: set `routing.supervisor_payload = metadata_only`.

**Stage C — Supervisor LLM** only if Stage B did not assign a project (global chat still needs a model), **or** to split/merge topics **after** a project is assigned.

Supervisor eligible models/auth profiles: never a project-owned profile that is not allowlisted for Supervisor/system. For `metadata_only` events the prompt contains only:

- project_id, project_name, confidentiality
- channel, sender, timestamp
- byte size, MIME, attachment count
- user-visible summary: first 120 characters of **text** if the text does not look like code/stack traces (heuristic: fences, `Traceback`, repo file paths). If heuristic fires, summary is `[redacted confidential body; open in that project's task context]`
- **No** attachment bytes, **no** repo contents, **no** logs

If Stage B assigned a confidential project, Supervisor may choose: attach to conversation, create task, or store memory — using metadata_only. The **task worker** (eligible profile for that project) later reads the full Inbox Event.

If Stage B assigned nothing, the event is **global Supervisor chat**. Full text is allowed only if no confidential heuristic fired; if it looks confidential and no project is known, create `waiting_for_user` with Issue “Which project is this?” Fail closed — do not send suspected confidential bodies to a free/consumer model.

**Stage D — user correction.** Control Center and a WhatsApp one-tap (when Issue exists) can move the event. Audit it. Do not “train” a model; just write `routing_overrides`.

**Splitting:** one voice note may yield multiple tasks. Original Inbox Event stays linked to all. Split is done inside an **eligible** task context for that project. Default STT for personal/normal/global: Groq Whisper (system connection). Confidential/professional audio: only STT profiles allowlisted for that project. If none, task waits with Issue.

## Why

Plan §28.2 says the Supervisor may capture and route professional/confidential requests but must not see repository contents, logs, code, or confidential attachments. “Minimize exposure” needs a deterministic first stage and a redacted Supervisor payload. Global chat is required so first-run does not need a pre-created application project (ADR 012).

## Alternatives rejected

- **Always send full WhatsApp text to GPT-OSS on Groq** — leaks confidential project content to a consumer/free endpoint.
- **Separate WhatsApp number per project** — not in the plan; one dedicated Jarvis number.
- **Supervisor uses a project-owned subscription** — forbidden: those profiles are task-only for that project.

## Consequences

- Implementation of §15 starts with Stage B code, not a prompt.
- Acceptance §80.1 uses a **temporary** professional project created in the test, not a seeded tenant.
- Correlation window is 10 minutes.

## User approval required

No. Generic confidential STT: not sent to Groq/NVIDIA/Google until that project's policy lists the profile.

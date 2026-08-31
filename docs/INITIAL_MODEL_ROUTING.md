# Initial model routing

Plan §35 candidates, turned into **bootstrap routes**. IDs are verified against the live catalog when the Netcup box is set up. If a named candidate is gone, pick the closest current model from the **same provider + same role** and record it in `model_registry` — do not silently switch providers or enable paid APIs.

This is **Groq** (groq.com inference), not xAI Grok.

Metered spend stays **off** unless Enrique sets a ceiling on that auth profile.

## Auth profiles to collect at Netcup bootstrap

| Profile | Kind | Used for |
|---|---|---|
| `groq` | API key | Supervisor, utility, STT |
| `nvidia` | API key | Supervisor/engineer/utility fallbacks |
| `google_ai` | API key | Supervisor/utility/vision Gemini |
| `anthropic_personal` | Host subscription login (ADR 006) | Supervisor fallback, personal engineering, review |
| `openai_codex_personal` | Host ChatGPT/Codex login | Engineering / Supervisor candidate |
| `cursor_personal` | Host Cursor ACP login | Engineering |
| `elevenlabs` | API key | TTS / phone later |
| `github_personal_admin` | PAT or GitHub App (broker only) | Create private repos later |
| `backup_b2` | B2 keys | Restic |
| `netcup_scp` | SCP OAuth refresh token (after the server exists) | Jarvis sees/manages its own instance |

Not model providers (later phases, still on this machine): Telnyx, WhatsApp session, Netlify. Do not block first chat on those.

## Recommended initial routes (after catalog check)

| Role | Primary | Then |
|---|---|---|
| Supervisor | Groq `openai/gpt-oss-120b` | NVIDIA Nemotron-class if listed; else current strong Gemini Flash-class; then Claude on `anthropic_personal` |
| Utility | Groq `openai/gpt-oss-20b` | Groq Qwen3-class if listed (plan said Qwen 3.8 27B — use current Groq Qwen); NVIDIA Lightning-class; Gemini Flash-Lite-class |
| Senior Engineer | `anthropic_personal` current Sonnet/Opus | Codex subscription; Cursor ACP; NVIDIA DeepSeek/Kimi **only if** that exact model is in the NVIDIA catalog and the profile is allowlisted |
| Engineering Reviewer | Different family from the implementer | If only Anthropic is allowed, a second Claude context |
| Speech-to-Text | Groq `whisper-large-v3-turbo` | Groq `whisper-large-v3` |
| Voice/TTS | ElevenLabs (pinned `voice_id` in site.yaml) | — |
| Embeddings | Local EmbeddingGemma-class GGUF when RAM policy allows (ADR 007) | skip until idle RAM |
| Vision/Document | Current Gemini vision-capable Flash-class | Anthropic vision if needed and allowlisted |

Supervisor **must never** use a project-owned profile (none exist at boot anyway).

## What “verify at deployment” means

On the Netcup box, a bootstrap step calls each provider’s model list (or `/acp doctor` / CLI for subscriptions). Write pinned `model_id` + version into `model_registry` with `approval_state=approved` for the rows that actually exist. Candidates that do not exist stay `discovered` / not routed. Do not invent IDs.

Improvement’s weekly job refreshes this; it does not auto-enable billing.

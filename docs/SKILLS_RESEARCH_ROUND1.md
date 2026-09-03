# Jarvis Skill & Integration Discovery — Round 1

**Author:** Skill & Integration Discovery Agent (research-only)
**Date:** 2026-09-03
**Status:** Recommendation only. Nothing here is installed, cloned, run, or activated. No plan/broker file was changed. Every trust/billing/scope crossing is flagged **REQUIRES USER APPROVAL** for the operator to decide through the §58 Improvement workflow.
**Anchored to:** `JARVIS_MASTER_PLAN_V2.md` (canonical; supersedes v1.2) §S31, §VI.0, §VII.4, §IV.4, §IV.6, §IV.6b; `CREDENTIAL_BROKER.md`; `SUPERVISOR.md`; `DATA_MODEL.md`; ADRs 005/008/009/010/012/017/019; `IMPLEMENTATION_CONTRACT.md` §5.3. Current build step is **S31 — Composio and MCP** (`PROGRESS.json`), so this research feeds work already in flight.

> **All external web content below was treated as untrusted data.** Star counts, licences, and "official" claims are what the sources assert; where a fact is load-bearing for a base-layer decision it is flagged for verification at attach time, exactly as S31 requires (classify against evidence, not against the vendor's own description).

---

## 0. How this maps onto how Jarvis actually models a skill

Jarvis does **not** have a generic "install this MCP" button. Every external capability is one of five things, and all five are gated by the credential broker (`CREDENTIAL_BROKER.md`, plan §IV.4):

| Path | Vocabulary already in the repo | Where it is built |
|---|---|---|
| Supervisor tool (in-loop, non-executing) | `TOOLS` in `src/supervisor.ts` / `SUPERVISOR.md` | Core |
| Broker capability (typed, gated call) | `github.repo.open_pull_request`, `netlify.create_deploy`, `connection.test` | Core `internal/broker` |
| MCP server | `mcp.call` (server id + tool; server must have declared permissions) | S31 `ConnectorInterface` |
| Composio adapter | `composio.invoke` (tool + args; allowlisted tools per connection) | S31 |
| API / direct / native connection manifest | `connections.kind ∈ github/netlify/composio/mcp/http/other`, `scope ∈ system/shared/project/task_ephemeral` | `packages/integrations` |

S31 already collapses these into **one `ConnectorInterface` with four kinds** (`composio`, `mcp`, `direct`/`api`, `native`) that all resolve through the same check order — *connection exists → project allowlist → role allowlist → confidentiality → spend → always-confirm* — and every tool a server exposes is **classified once, by a person, at attach time** into IV.6's three levels, pinned to a hash of the tool manifest.

**Consequences that shaped every recommendation below:**

1. **The gate is IV.6's three levels, enforced in the broker, not in the model.** Level 1 (read/search/scrape/write code/run tests/open PR/read-only DB) is autonomous; Level 2 (issue/draft/staging/dev-DB/post internally) is per-project policy; Level 3 (prod deploy, send external email, delete prod data, purchase, publish, change infra, rotate creds) is always-confirm with re-auth, and **no grant ever reaches Level 3**.
2. **Unclassified means the strict reading (IV.6b Rule 4).** An unclassified MCP tool is not callable; an unlabelled target is production; a tool whose only evidence of safety is its own description classifies **Level 3 by default**.
3. **A tool description — and a skill's instructions — are untrusted content, twice over (S31).** They reach the model's context *and* the human classifier. They are never assembled into instructions, and what a tool returns is data, not a reason to widen what runs next.
4. **The highest-trust move is frequently to add nothing.** Jarvis already owns, as first-class broker-gated planes, several capabilities that the ecosystem sells as MCP servers: GitHub (`github.*`), the model router (§VI.0), memory (Postgres, ADR 019), scheduling (OpenClaw, ADR 001). Bolting an MCP over those **re-opens the exact bypass S31 exists to close.** §1 below is therefore as important as the shortlist.

---

## 1. What NOT to add (it re-introduces a bypass, or duplicates a plane Jarvis already owns)

This is a first-class finding, not an appendix. Each of these is a popular, well-maintained, tempting server that should stay **out of the base** because Jarvis already has the capability behind a gate the MCP would sidestep.

| Ecosystem tool | Why it looks attractive | Why it is refused for base | Correct Jarvis path |
|---|---|---|---|
| **GitHub MCP server** (`github/github-mcp-server`, official, ~stateless 2026 spec) | One server, all of GitHub | It **holds its own token and makes its own calls** — the precise hole S31/IV.6b name. Merge/deploy would arrive with no broker gate. | Existing broker caps `github.repo.*` / `github.admin.*` (S5/S7, live). Keep them canonical. |
| **Reference `memory` server** (knowledge-graph) / **Qdrant / Chroma MCP** | Instant "agent memory" | Jarvis memory is `memory_items` / `knowledge_chunks` in Postgres with keyword search first (ADR 019 "Postgres search before embeddings"). A second store fragments the source of truth. | Postgres tables now; a vector store only *when* embeddings land (ADR 007) — see backlog B4. |
| **LiteLLM / OpenRouter** (LLM gateway) | 100–400 models behind one key, budgets | Jarvis has its own router: `model_registry`, `model_usage`, `model_policy`, `quota_observations`, route = `role+model+provider+auth_profile+project_policy` (§VI.0, ADR 017). Plan §3 forbids duplicate fallback engines. **OpenRouter also routes confidential bodies to third-party inference — forbidden by ADR 005.** | Keep the hand-rolled router. Re-evaluate LiteLLM only if it proves insufficient (backlog B9). |
| **Reference `filesystem` / `git` MCP servers** | File + repo tools for the agent | The engineering harness sandbox already has file, git, and shell (ADR 015/016-unix-users). Marginal value; more surface. | Harness. Optionally a *scoped* filesystem server for non-harness (utility/browser) lanes only. |
| Any **cron/scheduler MCP** | "Let the agent schedule" | OpenClaw owns schedule execution; Postgres mirrors it (`schedules`, ADR 001). Plan §3 forbids duplicate schedulers. | Existing schedule plane. |

**Rule for the base, stated once:** prefer the broker capability over the MCP whenever Jarvis already owns the account. An MCP earns base status only when it adds a capability Jarvis does **not** already have a gated plane for.

---

## A. Round-1 base skill library (always-on)

Small, high-trust, self-hostable / permissive / local-first first. Each is either (a) a local reference server with no data egress, (b) a self-hostable engine, (c) a first-party Agent Skill that runs inside the sandbox, or (d) the connector interface itself. Anything that ships an outbound credential to a third party is **not** here — it is backlog with approval.

### A0. The interface itself (already in flight — S31)
**Base means: finish and keep the seam, not pre-connect any vendor.** The `ConnectorInterface` (four kinds), the per-connection **permitted-action set**, attach-time **Level 1/2/3 classification pinned to a manifest hash**, untrusted-description handling, per-invocation **timeout + disable-on-repeat**, and Docker isolation for untrusted servers. Broker vocabulary: `mcp.call`, `composio.invoke`, plus the `direct`/`native`/`api` kinds. *Why always-on:* it is the seam every other skill rides; S31 is the current step.

### A1–A10. The always-on set

| # | Skill | What it does | Category | Integration path | Proposed capability id(s) | Gate (IV.6) | Why always-on |
|---|---|---|---|---|---|---|---|
| A1 | **Fetch** (MCP reference server) | URL → clean markdown for a single page | web / research | `mcp.call` server `fetch` (local, no creds) | `mcp.call{fetch.fetch}` | **L1** | Lightweight research for the Supervisor/utility lane without spinning a browser or harness. MIT, official, local, zero egress beyond the fetched URL. |
| A2 | **Brave Search API** (web search) | Independent-index web search | web search | API adapter, `scope=shared` connection, `kind=http` | `websearch.query` (new) | **L1** | Jarvis has no search plane today. Brave runs its **own index and does not log/collect query data** — the best privacy posture for a box that also handles confidential projects. Needs one API key. |
| A3 | **Playwright MCP** (Microsoft) | Accessibility-tree browser automation (Mode 1) | browser | `mcp.call` server `playwright` **inside the browser worker**, wrapped by the S32 Mode-1 gate | `browser.navigate` (L1), `browser.act` (L2/L3) | **L1 read / L2–L3 on state change** | Official, ~36k★, accessibility-tree (cheaper/robuster than screenshots), Chromium/Firefox/WebKit. It **is** S32 Mode 1 — but Mode 1 is an authorization bypass, so it ships with the gate built in: read-only default, approval on any state change, creds only via broker. |
| A4 | **Firecrawl (self-hosted)** | scrape / search / crawl / extract, strategy-laddered | scraping | self-host via Docker Compose; API adapter `kind=http/direct` pointed at the local instance | `scrape.fetch`, `scrape.search`, `scrape.crawl` (new) | **L1** (read) | Gives S32's Mode-2 fetch tiers immediately and, **self-hosted, no page content leaves the box**. ⚠ core is **AGPL-3.0** (fine for an internal server; note for any redistribution) and this is **pending ADR 016** — recommend as the leading Mode-2 backend, not a fait accompli. |
| A5 | **MarkItDown** (MCP, MIT) | PDF/DOCX/PPTX/XLSX/EPUB/HTML → markdown | file & document | `mcp.call` server `markitdown` (local, no creds) | `mcp.call{markitdown.convert}` → wrap as `doc.to_markdown` | **L1** | Turns every uploaded attachment into model-readable text locally, no GPU, no cloud. MIT, Microsoft, ~high adoption. Pairs with the plan's file-safety (quarantine → sniff → convert). |
| A6 | **Anthropic document-skills** (Agent Skills: `docx`, `pdf`, `pptx`, `xlsx`) | Read *and* author Office/PDF artifacts | file & document | **Agent Skill** loaded by the harness (not a broker connection) | n/a (produces artifacts; L1) | **L1** | The reverse of A5: Jarvis produces real .docx/.pptx/.xlsx deliverables. First-party, production-tested. ⚠ **source-available, verify licence terms** before redistribution; runs in the harness sandbox, so governed by A6-note below. |
| A7 | **skill-creator** (Agent Skill, first-party) | Scaffolds new Agent Skills | self-improvement | Agent Skill in the harness | n/a (L1, produces a skill artifact for review) | **L1 to author; adoption gated** | Directly realises plan §58 "Jarvis can create a new MCP server or adapter when none exists." Authoring a skill is L1; *activating* it is the same gate as any other skill (A6-note). |
| A8 | **Postgres MCP — restricted / read-only** (`crystaldba/postgres-mcp`) | Read-only DB analysis, EXPLAIN, index/health advice | database / RAG-adjacent | `kind=direct` connection, **broker injects a read-only credential**, server run in `--access-mode=restricted` | `db.analyze_readonly` (new) | **L1** (read-only analysis is L1 per IV.6) | Read-only DB analysis is explicitly Level 1; this makes the Senior-Engineer role able to investigate a project's own database safely. ~2.8k★, updated Jan 2026. ⚠ writes would be L3 — restricted mode + read-only role must be enforced by the broker, not the server's own flag. |
| A9 | **Sequential-thinking + Time** (MCP reference) | Structured reasoning scratchpad; timezone/clock math | utility | `mcp.call` servers `sequentialthinking`, `time` (local, no creds) | `mcp.call{…}` | **L1** | Zero-credential, zero-egress, MIT, official. Near-free to keep on; `time` is genuinely useful given the America/New_York quiet-hours logic. Include only if the marginal context cost is acceptable — otherwise backlog. |

**Base count: A0 (interface) + A1–A9 = ~11 skills across the required categories** (research, web search, browser, scraping, document-in, document-out, self-authoring, DB, utility), and every one is local/self-hosted or first-party. The only outbound credential in the whole base is **A2 Brave's API key** (a read-only search key with no query logging), which still requires a one-time approval to add the connection.

> **A6-note — Agent Skills need the same governance as MCP tools, and the plan does not yet say so.** An Agent Skill (`agentskills.io` open standard, adopted by ~40 clients per the sources) is *instructions + scripts the harness auto-loads and follows*. That is a prompt-injection **and** code-execution surface identical in kind to an MCP server. S31's four rules must extend to skills: **first-party only in the base; any third-party/community skill goes through §58** (source review, static checks, sandbox, pin to a content hash, no silent activation). This is a genuine gap → see **D / ADR proposal**.

---

## B. Prioritized backlog (ranked value ÷ effort within each group)

Each entry is a candidate Jarvis can later run through the §58 pipeline. **App/trust/billing crossings are flagged.**

### B1 — Comms (high value, all cross a trust boundary → approval)
1. **Google Workspace MCP** (`taylorwilsdon/google_workspace_mcp`, MIT, ~2.5k★, native OAuth 2.1) — Gmail/Calendar/Drive/Docs/Sheets read+write. *Read is L1–L2; **send email is L3**.* **REQUIRES USER APPROVAL** — broad OAuth scope, third-party server holding a Google token (secret-scope boundary, §59). Prefer read-only scopes first; wire send as a Level-3 broker capability.
2. **Slack — official MCP** (GA 2026-02-17, remote/OAuth, search+message+canvas) — L2 internal post / L3 external-ish. **APPROVAL** (workspace data + third-party). Self-host alternative: **`korotovsky/slack-mcp-server`** (no-permission tokens, ~30k monthly repo visits) for read/archive.
3. **Telnyx / ElevenLabs** — *already in the plan* as the telephony + voice planes (OpenClaw voice-call runtime, `calls`/`call_turns` tables). Community MCPs exist but **do not adopt** — the direct integration is canonical. ElevenLabs MCP is optional for ad-hoc TTS only.

### B2 — Observability / health (medium value)
4. **Sentry MCP** (`getsentry/sentry-mcp`, official, remote `mcp.sentry.dev`, OAuth, ~20 tools) — read error/perf data for the Maintenance project. **APPROVAL** — cloud SaaS, data egress. For a local-first box prefer a **self-hosted error store** (self-hosted Sentry / GlitchTip) reached as a `direct` connection, keeping data on-box.

### B3 — Web search / retrieval alternates (low effort)
5. **Tavily** (LLM-tuned answers, 1k free credits/mo) and **Exa** (semantic + find-similar) as *secondary* search connections behind the same `websearch.query` capability. Add per-need; **Exa is the only real option for "find similar pages"**. All cross a provider boundary (metered) → approval to enable billing beyond free tier.

### B4 — Memory / RAG / vector (deferred by design)
6. **Qdrant MCP** (`qdrant/mcp-server-qdrant`, official, **local mode** via `--qdrant-local-path`, Apache-2.0/MIT — licence discrepancy in sources, verify) — a `qdrant-store`/`qdrant-find` semantic layer **when embeddings land** (ADR 007 local EmbeddingGemma + ADR 019 sequencing). Local mode keeps vectors on-box. Until then, Postgres keyword search stands.

### B5 — Document handling depth (low effort)
7. **Docling** (IBM, MIT, local) — superior PDF **table/formula/multi-column** extraction; add alongside A5 (MarkItDown fast/shallow, Docling slow/structured) and route by document type. No egress.
8. **Context7** (`upstash/context7`, MIT) — up-to-date, version-specific library docs for the Senior-Engineer role. Free tier keyless; API key raises limits. Low risk (read-only docs), mild egress of *query* terms → approval for the key.

### B6 — Infra / deploy (high blast radius)
9. **Cloudflare MCP** (official, remote `mcp.cloudflare.com`, DNS/Workers/R2/KV via `search()`+`execute()`) — only if the operator wants Jarvis managing Cloudflare. **REQUIRES USER APPROVAL** — infra **write is L3**, new provider + billing. Netlify is already a broker system connection; no MCP needed there.

### B7 — General tool breadth (accounted, not expanded)
10. **Composio toolkits** — the `composio` kind is base infrastructure (A0/S31), but **each specific toolkit** (1,089 toolkits / 20k+ tools per the catalog, MIT SDK, self-hostable) is a separate adoption with its **own permitted-action set** and its own OAuth. Enable per-need, per-action, never "project A may use Composio" as a boolean. Every toolkit = approval.

### B8 — Payments (mostly domain, L3)
11. **Stripe MCP** (`stripe/ai`, official, ~25 tools, OAuth) — L3 for anything that moves money; read (balance/customer/invoice) is L2. **APPROVAL**. Relevant mainly to the operator's own business billing (see C).

### B9 — Model routing (only if needed)
12. **LiteLLM (self-hosted proxy)** — reconsider *only* if the hand-rolled router (§VI.0) proves insufficient; it would need an ADR because it changes the model plane. Not recommended now.

### B10 — Discovery plumbing for Improvement (near-zero effort, high leverage)
13. Wire the **official MCP Registry** (`registry.modelcontextprotocol.io`, preview, backed by Anthropic/GitHub/Microsoft/PulseMCP) plus **Glama / PulseMCP** metaregistry (Glama tracked ~81.8k servers as of 2026-09-01; ~116k across all registries) as the **weekly discovery feed** for the §VII.4 Improvement job — with the plan's own decline-recording and cap-on-asks so a "no" in March is not re-pitched in April. This is config, not a new plane.

---

## C. Domain-adjacent (ticket-broker) — kept OUT of the base

The operator runs a ticket-reselling tools business (Ticketmaster, AXS, StubHub, SeatGeek, Vividseats, TickPick, Gametime). These belong to *professional projects*, gated by that project's own auth profiles and confidentiality policy — never in the always-on base, never on the personal GitHub credential.

| Skill | What | Path | Gate / notes |
|---|---|---|---|
| **Apify ticket scrapers via Apify MCP** | Ready-made Ticketmaster / StubHub / TickPick / SeatGeek / Vividseats event+price scrapers as MCP tools | `mcp.call` (Apify MCP) or Composio; project-scoped, metered | L1 read, **metered → spend policy + approval**. The operator already runs first-party Selenium scrapers (`tmapi`); Apify is a *fallback/augment*, not a replacement, and its output is an **artifact with a source**, never memory (S32). |
| **Bright Data** | Paid residential proxy (already used for tickets.com MLB) | `direct`/`http` connection, project-scoped | Metered, hard per-task cap already in team practice → spend ceiling + approval. |
| **Broker Copilot MCP** (operator's own product) | `query_market_data`, `query_pos_data`, `flare_*`, `search_slack/gmail/demo_calls` | Existing product MCP; wrap as a project connection if a Jarvis project manages Copilot | Project-scoped; POS/customer data is **confidential** → ADR 005 routing, no confidential body to an ineligible model. |
| **Marketplace/POS APIs** (Skybox, Lysted, StubHub Pro, Ticketmaster partner) | Inventory/pricing/orders | API adapters per project | Order/list/purchase actions are **L3**; read is L2. Per professional-project onboarding (§28.2). |

---

## D. Proposed plan / broker changes

Concrete, minimal, and each flagged where it crosses a §59 boundary.

### D1 — New capability-catalog rows (`CREDENTIAL_BROKER.md`)
| id | kind | extra confirm | credential |
|---|---|---|---|
| `websearch.query` | http (Brave/Tavily/Exa) | no (L1 read) | provider API key, read-only |
| `scrape.fetch` / `scrape.search` / `scrape.crawl` | http/direct (Firecrawl self-host) | no (L1) | local instance token |
| `doc.to_markdown` | mcp (MarkItDown) / native | no (L1) | none (local) |
| `db.analyze_readonly` | direct (Postgres MCP restricted) | no (L1) — **write path stays L3** | broker-injected **read-only** DB cred |
| `browser.navigate` | mcp (Playwright) | no (L1) | none (site creds via broker only) |
| `browser.act` | mcp (Playwright) | **per S32**: L2 by project policy, L3 for destructive/purchase/prod | site creds via broker, scoped to one site |

Plus per-server `mcp.call` allowlist entries (`fetch`, `markitdown`, `sequentialthinking`, `time`, `playwright`) and per-tool `composio.invoke` allowlists.

### D2 — New connection manifests (`packages/integrations`)
`brave_search` (scope=shared, kind=http, api_key), `firecrawl_selfhost` (scope=system, kind=http/direct, local), `markitdown` (kind=native/mcp, local), `playwright` (kind=native/mcp, local, browser-worker only), `postgres_readonly_<project>` (scope=project, kind=direct, read-only role). Optional: `tavily`, `exa`, `apify` (project-scoped, metered).

### D3 — New auth profiles (`auth_profiles`)
`brave_search` (api_key, confidentiality_eligibility incl. confidential given no query logging — verify), and per-project `apify`/`brightdata` profiles created at onboarding, never at boot.

### D4 — ADRs needed
- **ADR 016 (Browser & scraping)** — *already flagged pending by S32.* Should decide: Firecrawl-self-hosted vs. hand-rolled Mode-2 emitter; the fingerprinted-HTTP client (the transcript's "Paw HTTPS" ≈ `curl_cffi`/`pyhttpx` — **confirm with operator**); egress policy for the browser container.
- **NEW ADR — Agent Skills governance.** Extend S31's classify-at-attach / pin-to-hash / untrusted-description / no-silent-activation rules to Agent Skills, because a skill is instructions **and** scripts the harness executes. Base = first-party (Anthropic) skills only; community skills go through §58. **This is the sharpest gap surfaced by this round.**
- **NEW ADR (or extend ADR 005) — Search/scrape privacy eligibility.** Which search/scrape providers are eligible for **confidential** projects (Brave's no-logging independent index is the strongest candidate; consumer search endpoints that train on queries are excluded, mirroring §36).

### D5 — §59 boundary crossings — **REQUIRES USER APPROVAL** (explicit list)
Adding **any** of these introduces a new provider / trust / billing / secret-scope relationship and must be approved, never silently activated:
- **A2 Brave Search API** — new provider + API key (read-only, no logging; lowest-risk of the set, but still a new outbound credential).
- **A4 Firecrawl** — *self-hosted = no data egress and no new provider trust*, but still needs a connection manifest + attach-time classification. **Firecrawl Cloud (managed proxy) WOULD cross the boundary** — self-host only for base.
- **B1 Google Workspace MCP / Slack MCP** — third-party server holding OAuth tokens; broad scope; email/DM send is L3.
- **B2 Sentry cloud** — data egress to a SaaS.
- **B3 Tavily / Exa (beyond free tier)** — metered spend.
- **B6 Cloudflare MCP** — infra write (L3) + new provider.
- **B7 each Composio toolkit** — new OAuth per service.
- **B8 Stripe** — payments (L3).
- **C Apify / Bright Data / marketplace APIs** — metered spend + professional-project confidentiality.
- **Any third-party Agent Skill** — code + injection surface (per new ADR).

Everything in the **base except A2 and A4's connection-manifest step** stays inside existing boundaries: local reference servers (A1, A5, A9), first-party in-harness skills (A6, A7), a broker-injected read-only DB credential (A8), and Playwright driving a local browser (A3) do **not** cross §59 — but all still require a connection manifest and attach-time Level classification before use (IV.6b Rule 4).

---

## E. Sources

All URLs were read as untrusted data on 2026-09-03. "Why trusted" reflects first-party vs. aggregator and is a judgement, not a guarantee.

| # | URL | Maintainer / source | Licence (as claimed) | Why used / trust note |
|---|---|---|---|---|
| 1 | https://github.com/modelcontextprotocol/servers | MCP project (Anthropic-led) | MIT | Canonical reference-server set: fetch, filesystem, git, memory, sequentialthinking, time, everything. First-party. |
| 2 | https://github.com/modelcontextprotocol/servers-archived | MCP project | MIT | Confirms GitHub/GitLab/GDrive/Postgres/Puppeteer/Brave **archived, "no security guarantees"** — basis for §1. First-party. |
| 3 | https://modelcontextprotocol.io/registry/about • https://registry.modelcontextprotocol.io/ | MCP project (Anthropic/GitHub/Microsoft/PulseMCP) | — | Official registry, still **preview** in 2026; discovery feed for B10. First-party. |
| 4 | https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/ | MCP project | — | 2026-07-28 spec RC (stateless). First-party. |
| 5 | https://github.com/github/github-mcp-server | GitHub | (Apache/MIT — verify) | Official GitHub MCP + toolsets; basis for the §1 "don't bypass the broker" call. First-party. |
| 6 | https://composio.dev/pricing • https://github.com/ComposioHQ (SDK) | Composio | MIT (SDK, self-hostable) | Catalog size (1,089 toolkits / 20k+ tools, Aug 2026), pricing, self-host. Vendor page — figures are vendor-claimed. |
| 7 | https://github.com/microsoft/playwright-mcp | Microsoft | Apache-2.0 (verify) | Official browser MCP, ~36k★, accessibility-tree; A3. First-party. |
| 8 | https://github.com/firecrawl/firecrawl-mcp-server • https://docs.firecrawl.dev/contributing/self-host | Firecrawl | **AGPL-3.0** core | A4 self-host + keyless free tier; AGPL flag. First-party + docs. |
| 9 | https://brave.com/learn/best-search-api-2026/ • https://www.firecrawl.dev/blog/best-web-search-apis | Brave / Firecrawl (aggregator) | — | Brave independent index + **no query logging** (A2 privacy basis); Tavily/Exa comparison (B3). Brave page is first-party for its own claim; comparison is an aggregator — treat rankings as opinion. |
| 10 | https://github.com/getsentry/sentry-mcp • https://mcp.sentry.dev | Sentry | (verify) | Official Sentry MCP, remote+OAuth, ~20 tools; B2. First-party. |
| 11 | https://github.com/elevenlabs/elevenlabs-mcp | ElevenLabs | (verify) | Official TTS/STT/voice MCP; already-subscribed provider. First-party. |
| 12 | https://github.com/anthropics/skills • https://agentskills.io | Anthropic | source-available (skills) / spec open | Agent Skills open standard (Dec 2025), document-skills, skill-creator, template; A6/A7 + governance gap. First-party. |
| 13 | https://github.com/microsoft/markitdown | Microsoft | MIT | A5 doc→markdown, local, `markitdown-mcp`. First-party. |
| 14 | https://github.com/docling-project/docling | IBM | MIT | B7 PDF-structure extraction, local. First-party. |
| 15 | https://github.com/crystaldba/postgres-mcp | Crystal DBA | (verify) | A8 read-only DB analysis, restricted mode, ~2.8k★, Jan-2026 update. First-party. |
| 16 | https://github.com/qdrant/mcp-server-qdrant | Qdrant | Apache-2.0/MIT (sources conflict — verify) | B4 local-mode vector memory. First-party. |
| 17 | https://github.com/taylorwilsdon/google_workspace_mcp | T. Wilsdon (community) | MIT | B1 Gmail/Calendar/Drive, OAuth 2.1, ~2.5k★. Community — vet before trusting with Google tokens. |
| 18 | https://github.com/korotovsky/slack-mcp-server | korotovsky (community) | (verify) | B1 self-host Slack alt. Community. |
| 19 | https://github.com/makenotion/notion-mcp-server • https://mcp.notion.com/mcp • https://mcp.linear.app | Notion / Linear | — | B (task mgmt), remote OAuth. First-party. |
| 20 | https://github.com/cloudflare/mcp-server-cloudflare • https://mcp.cloudflare.com/mcp | Cloudflare | (verify) | B6 DNS/Workers/R2, remote; infra write = L3. First-party. |
| 21 | https://mcpservers.org/servers/stripe/agent-toolkit • https://github.com/stripe/ai | Stripe | (verify) | B8 payments MCP, ~25 tools, OAuth; L3. First-party (repo) + aggregator (listing). |
| 22 | https://github.com/upstash/context7 | Upstash | MIT | B5 up-to-date library docs; keyless free tier. First-party. |
| 23 | https://www.truefoundry.com/blog/litellm-vs-openrouter • https://openrouter.ai/blog/insights/openrouter-vs-litellm/ | TrueFoundry / OpenRouter | — | B9 gateway comparison + §1 duplication note. Aggregator + vendor — opinion. |
| 24 | https://glama.ai/mcp/servers • https://www.pulsemcp.com | Glama / PulseMCP | — | B10 ecosystem size (~81.8k Glama / ~116k total, Sep 2026). Aggregators — counts are self-reported. |
| 25 | https://apify.com (Ticketmaster/StubHub/TickPick scraper MCP actor pages) | Apify + third-party actor authors | per-actor | C domain scrapers as MCP. Marketplace — **actor authors are untrusted third parties**, vet each. |

---

### One-paragraph bottom line
Jarvis should add a **small, local-first base**: the S31 connector interface itself, a handful of zero-egress reference servers (fetch, markitdown, sequential-thinking/time), a privacy-respecting web-search key (Brave), Microsoft's Playwright MCP wrapped by the S32 browser gate, self-hosted Firecrawl for scraping (pending ADR 016), a read-only Postgres analysis server, and the first-party Anthropic document/skill-creator Agent Skills. It should **decline** GitHub-MCP, memory/vector servers, and LLM gateways for the base because Jarvis already owns those planes behind broker gates, and bolting an MCP over them re-opens the exact bypass S31 closes. Everything with an outbound third-party credential — Google/Slack/Sentry/Cloudflare/Stripe/Composio-toolkit/Apify — is backlog behind explicit §59 approval. The one architectural gap this round surfaces is that **Agent Skills need the same attach-time governance as MCP tools**, and that deserves its own ADR.

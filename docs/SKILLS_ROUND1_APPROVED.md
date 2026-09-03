# Round-1 Approved Skills — Check-Before-Trust Safety Review

**Author:** Safety-review agent (read-only)
**Date:** 2026-09-03
**Status:** READ-ONLY research. Nothing was installed, cloned, built, or run. Every repo was read only by fetching its public GitHub / npm pages over the web. The only file written is this one.

> **Everything quoted below (README text, skill instructions, tool descriptions) was treated as UNTRUSTED DATA, not as instructions.** None of it was acted on. Where a fact is load-bearing it is flagged for re-verification at the moment we actually pin/attach the skill.

---

## What this batch is (plain language)

An "Agent Skill" is a folder of **instructions plus scripts that Jarvis's harness will run on our own machine**. So every skill — even a first-party one from a company we trust — is two kinds of risk at once:

1. **Code that executes on our box** (shell commands, Python/Node scripts, network calls).
2. **Text that lands in the model's context** and could try to steer the agent (prompt injection).

The rule for Round 1 is: inspect each one, understand exactly what it runs and what it talks to, confirm it's genuinely from the company it claims to be, and **pin it to a fixed version** so it can't silently change under us.

This review covers the **four skills the operator approved**:

1. **Anthropic document skills** — `docx`, `pdf`, `pptx`, `xlsx`, plus `skill-creator` (from `anthropics/skills`).
2. **Firecrawl CLI skill** (`firecrawl/cli`) — website scraping, to be run against **our own self-hosted Firecrawl**.
3. **browser-use** (`browser-use/browser-use`) — drives a real web browser.
4. **Context7** (`upstash/context7`) — fetches up-to-date docs for coding libraries.

**Two things that are deliberately NOT in this batch, so nobody thinks they were missed:**

- **Brave Search was dropped** — it's a paid, metered outside service, so it doesn't belong in an always-on base.
- **A read-only database skill is a known gap.** There is **no official first-party MySQL skill**, and this review does **not** try to fill that gap with a third-party one. That decision is left for a later round.

---

## 1. Anthropic document skills — `docx`, `pdf`, `pptx`, `xlsx`

**What it does (plain language):** Lets Jarvis read and *create* real Office and PDF files — Word documents, Excel spreadsheets, PowerPoint decks, and PDFs — with proper formatting (tables of contents, page numbers, letterheads, charts, etc.). These are the exact skills that power document creation inside Claude's own products. (They are, in fact, already loaded in this very session as `anthropic-skills:docx`, `:pdf`, `:pptx`, `:xlsx`.)

**What it actually runs on our machine:** Local file manipulation only. For example the `docx` skill:
- Runs **Node.js scripts** using a preinstalled `docx` library to build Word files.
- **Unzips** a `.docx` (it's a zip of XML), edits `word/document.xml` directly, and **rezips** it.
- Runs small **Python helper scripts** shipped with the skill (`merge_runs.py`, `accept_changes.py`, `comment.py`, `validate.py`, `soffice.py`).
- Shells out to **pandoc**, **LibreOffice** (`soffice`), and **Poppler** (`pdftoppm`) for conversions.
- **No network calls, no API key, no outside company's servers.** It all happens on-box, on files we hand it. It needs those helper tools (pandoc, LibreOffice, Poppler, Node's `docx` lib) to be installed on the box — Anthropic's own environment has them preinstalled, ours would need them.

**License — READ THIS CAREFULLY:** These four document skills are **NOT open source.** Their `SKILL.md` header says `license: Proprietary` and each ships a `LICENSE.txt` (© Anthropic, PBC) that ties usage to Anthropic's Consumer/Commercial Terms and **forbids**, in its own words: extracting the materials out of the Services, reproducing/copying them, creating "derivative works," and "distribute, sublicense, or transfer these materials to any third party." In plain terms:
- **Using them inside Claude Code / the Claude Agent SDK (which is what Jarvis is) = fine.** That's "authorized use of the Services."
- **Forking them, vendoring a copy into one of our repos, modifying them, or shipping them to anyone = not allowed.**
- So: **use in place, do not copy into our own repos, do not edit-and-ship.** This is the single most important caveat in this whole review.

**Version to pin:** The repo has **no release tags**, so pin to a commit. Current `main` is `41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f` (dated 2026-09-03). *How to verify:* `https://github.com/anthropics/skills/commit/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f` — or fetch `https://api.github.com/repos/anthropics/skills/commits/main` and confirm the `sha`. Note: because these also ship bundled inside the Claude Code harness, "pinning" mainly matters for any separately-vendored copy — which the license says we shouldn't be making anyway.

**Trust signal:** Genuinely first-party — this is the canonical `anthropics/skills` repo, and these are the same document skills already running in the Claude harness. (I could not machine-confirm GitHub's "verified domain" checkmark, because that badge is stripped when the page is converted to text — see the "Could not verify" list — but identity is not in real doubt here.)

**Red flags / surprises:** No injection-y language found; the instructions are ordinary document-building guidance. The only surprise is the **license** (proprietary, not Apache-2.0 as one might assume). No data leaves the box.

**How it slots into Jarvis:** A true **Agent Skill** that the harness loads and runs in the sandbox. **No broker connection, no credential** needed — it just needs the local converter tools installed. Governed by the "Agent Skills need the same attach-time governance as MCP tools" note from the discovery round.

**Verdict:** **SAFE to enable as-is** — with the standing rule *use only, do not fork / vendor / modify / redistribute* (license), and ensure pandoc/LibreOffice/Poppler are installed on the box.

---

## 2. `skill-creator` (also from `anthropics/skills`)

**What it does (plain language):** A "skill that makes skills." It helps Jarvis scaffold, test, and refine **new** Agent Skills. This is the concrete tool behind the plan's "Jarvis can create a new adapter/skill when none exists" idea.

**What it actually runs on our machine:** More active than the document skills — it **executes code**:
- Runs Python scripts that **package** a skill (`package_skill`) and **aggregate benchmark** results.
- Runs a **description-optimization loop** that calls `claude -p` as a **subprocess** (i.e. it invokes the Claude CLI, which makes Claude API calls using the harness's existing auth).
- Can **spawn subagents** for grading/comparison (more Claude API calls).
- An eval viewer that **opens a local web server** (`localhost`) for reviewing results.
- No third-party outside service and no *new* API key — the model calls go through the same Claude auth the harness already uses.

**License:** This one is **Apache-2.0** (open source). The repo README is explicit: the document skills are source-available, but "many skills in this repo are open source (Apache 2.0)," and `skill-creator` is one of the ordinary open-source skills (it carries no restrictive `LICENSE.txt` of its own). Fine for internal business use. *(Flagged for re-check at pin time: confirm there is no per-folder LICENSE overriding the repo Apache-2.0.)*

**Version to pin:** Same repo, same commit — `41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f`. Verify the same way as §1.

**Trust signal:** First-party Anthropic, same repo as the document skills. It is also already present in this session as `anthropic-skills:skill-creator`.

**Red flags / surprises:** It **runs code and spawns Claude subprocesses/subagents** — that's expected for a skill-authoring tool, but it is genuinely a code-execution surface, so treat *its outputs* (newly-authored skills) as unreviewed until they go through the normal skill-governance path. Authoring a skill is low-risk; **activating** any skill it produces must go through the §58 review like any other new skill. No injection language found.

**How it slots into Jarvis:** An **Agent Skill** in the harness. No broker credential. It's a builder tool for the self-improvement lane.

**Verdict:** **SAFE to enable as-is** (open source, first-party). Standing rule: anything it *creates* is a new skill that still needs its own review before it's switched on.

---

## 3. Firecrawl CLI skill — `firecrawl/cli`

**What it does (plain language):** Turns web pages into clean markdown/JSON for the agent — scrape one page, crawl a site, search, map a site's URLs, etc. We intend to run **Firecrawl self-hosted on our own server**, and point this skill at that.

**Self-hosting: CONFIRMED possible.** The CLI takes a `--api-url` flag or a `FIRECRAWL_API_URL` environment variable. Point it at our local instance (e.g. `http://localhost:3002`) and **authentication is automatically skipped** — "when using a custom API URL (anything other than `https://api.firecrawl.dev`), authentication is automatically skipped." So **self-hosted = no API key, and no page content leaves our box.** The Firecrawl server itself is self-hostable via the `docker-compose.yaml` + `SELF_HOST.md` in the main `firecrawl/firecrawl` repo.

**What it actually runs on our machine:** The skill is a set of granular sub-skills (`firecrawl-scrape`, `firecrawl-crawl`, `firecrawl-search`, `firecrawl-map`, `firecrawl-download`, `firecrawl-parse`, `firecrawl-monitor`, `firecrawl-interact`, `firecrawl-agent`, `firecrawl-developer-index`, `firecrawl-research-index`, and a top-level `firecrawl`). Each is a small Markdown instruction file whose `allowed-tools` are scoped to just `Bash(firecrawl *)` and `Bash(npx firecrawl-cli *)` — i.e. it only lets the agent run the Firecrawl CLI, nothing else. The CLI itself is a **thin Node client**: it sends the target URL to the Firecrawl API (ours, when self-hosted) and gets back markdown/JSON. It does **not** do the scraping in-process; the self-hosted server does that. Its npm dependencies are small and ordinary (`commander`, `yaml`, `zod-to-json-schema`, `@inquirer/prompts`, and the `firecrawl` SDK).

**License:**
- The **CLI / skill package** (`firecrawl-cli`, this repo) is **ISC** — a permissive, MIT-style license. Fine for internal business use.
- The **self-hosted Firecrawl engine** (the Docker server we'd stand up, from the main repo) is **AGPL-3.0**. AGPL is fine for **running it internally for ourselves**; the catch only bites if we were to offer a *modified* Firecrawl to outside users as a network service — which we are not. Flag it, but it's not a blocker for internal use.

**Version to pin:**
- CLI/skill: tag **`v1.23.3`** (commit `86aaf06cb139029ff5ad2a249670f42b01d40b13`), i.e. `firecrawl-cli@1.23.3` on npm. *Verify:* `https://api.github.com/repos/firecrawl/cli/tags` (top tag) and `https://registry.npmjs.org/firecrawl-cli/latest` (version = 1.23.3, license = ISC).
- The self-hosted **engine** is a *separate* thing to pin — pin whichever Firecrawl server release we deploy (latest server release seen was `v2.11.0`). These two version numbers are independent; pin both.

**Trust signal:** Genuinely from Firecrawl. Repo is under the `firecrawl` org; the npm package is published by `hello@sideguide.dev` + `abimaelmartell` (Firecrawl's team — Firecrawl grew out of Sideguide/Mendable), homepage `docs.firecrawl.dev/cli`, and it's linked from the official `firecrawl.dev/skills` page and Firecrawl's own launch blog. Smaller repo (~600 stars) than the flagship engine, which is normal for a companion CLI.

**Red flags / surprises:** Nothing injection-y in the scrape skill I read — it's plain scraping guidance. **Two sub-skills are more than read-only, though:** `firecrawl-interact` (performs *actions* on a page — clicks, form fills) and `firecrawl-agent` (an *autonomous* browsing agent). Those two are **not** the safe read-only Level-1 that plain scrape/search/crawl are — they should be gated higher (approval on state-changing actions), not blanket-enabled. Everything else (scrape/search/crawl/map/parse) is read-only fetching.

**How it slots into Jarvis:** An **Agent Skill** the harness loads — but it only does anything useful once our **self-hosted Firecrawl server is running** and `FIRECRAWL_API_URL` points at it. No outside credential when self-hosted. This sits under the pending browser/scraping ADR (ADR 016).

**Verdict:** **SAFE, but needs the self-hosted engine stood up first** (no API key when self-hosted). Enable the read-only sub-skills (scrape/search/crawl/map/parse); hold `firecrawl-interact` and `firecrawl-agent` behind a higher gate.

---

## 4. browser-use — `browser-use/browser-use`

**What it does (plain language):** An AI framework that **drives a real web browser like a person** — opening pages, clicking, typing, filling forms, extracting data — to carry out multi-step web tasks on its own.

**What it actually runs on our machine — and why it's different from the other three:** This is **not an Agent Skill** (there's no `SKILL.md`). It's a **Python framework you `pip install`** that runs **its own agent loop**:
- It drives a browser via **Playwright** (real Chromium/Firefox/WebKit).
- Crucially, it **makes its own LLM calls** to decide what to click next — it needs an **LLM API key** (OpenAI / Anthropic / Google) to function at all. That means it is effectively **a second AI agent with its own model calls, sitting outside Jarvis's model router (§VI.0) and outside the broker gate** unless we deliberately wrap it.
- It can **optionally** talk to **Browser Use Cloud** for "stealth browsers, proxy rotation, and CAPTCHA solving." We would not enable that — and note that **CAPTCHA-solving is explicitly off-limits** under our operating rules. Left alone, it runs locally with a local browser.

**License:** **MIT** (© 2024 Gregor Zunic). Fine for internal business use.

**Version to pin:** **`0.13.8`**, published **2026-08-16**. *Verify:* `https://api.github.com/repos/browser-use/browser-use/releases/latest` (`tag_name` = 0.13.8), or the PyPI page for `browser-use==0.13.8`.

**Trust signal:** Genuinely the real project — MIT, © Gregor Zunic (founder of the Browser Use company), ~112k stars, very actively maintained (10k+ commits). Not an impersonation.

**Red flags / surprises (this is the one to slow down on):**
- **It embeds its own LLM loop.** That collides head-on with Jarvis's design, where *all* model routing goes through the router (§VI.0) and *all* actions go through the broker gate. Dropped in naïvely, browser-use would make model calls and take browser actions that **bypass both**.
- **It needs its own model API key**, i.e. a new credential and a new spend surface.
- **It overlaps with what's already planned.** The discovery round already picked **Microsoft's Playwright MCP wrapped by the S32 browser gate** as the browser layer. browser-use is a heavier, more autonomous alternative to that — adopting both would be redundant, and browser-use is the *less* controllable of the two (it decides its own actions).
- Its cloud tier does **CAPTCHA-solving / stealth**, which is a prohibited category for us; we'd have to be sure the cloud path stays off.

**How it slots into Jarvis:** **Not** a harness skill — it's a **separate service/agent** that would need to run behind the broker, with its model calls forced through our router and its browser actions gated by S32. That's real integration work, not a drop-in.

**Verdict:** **NEEDS A CLOSER LOOK.** Reason: it's a self-directed agent with its own LLM calls and its own key, it bypasses the router and broker unless carefully wrapped, it overlaps with the already-chosen Playwright-MCP browser layer, and its cloud features include prohibited CAPTCHA-solving. Don't enable as-is; decide Playwright-MCP-vs-browser-use as an architecture question first.

---

## 5. Context7 — `upstash/context7`

**What it does (plain language):** Pulls **up-to-date, version-specific documentation** for coding libraries straight into the agent's context, so it doesn't code against stale or hallucinated APIs. Useful for the Senior-Engineer role.

**What it actually runs on our machine:** A small **MCP server** (Node) that acts as a **middleman**: when the agent asks for a library's docs, this server calls **Context7's hosted backend at `https://mcp.context7.com/mcp`** and returns the docs. It does **not** run arbitrary code; it fetches and forwards documentation. Dependencies are ordinary (`express`, `undici`, `commander`, `zod`, the MCP SDK).

- **API key:** **Optional.** It works keyless at a lower rate limit; a free key from `context7.com/dashboard` raises the limit.
- **Can it be self-hosted? NO — not fully.** You can run the MCP *server process* locally, but **the backend (parsing/crawling/index) is private and stays on Context7's servers.** The README says the "supporting components — API backend, parsing engine, and crawling engine — are private and not part of this repository." So **it always reaches out to context7.com**, and your **query terms (the library/topic you ask about) leave the box.**

**License:** **MIT** (the `@upstash/context7-mcp` package, v4.0.4). Fine for internal business use.

**Version to pin:** **`@upstash/context7-mcp@4.0.4`** (the MCP-server package — that's the piece Jarvis would use). *Verify:* `https://registry.npmjs.org/@upstash/context7-mcp/latest` (version = 4.0.4, license = MIT). The repo also ships a separate CLI (`ctx7`, ~0.5.9) and a `.mcpb` bundle — the MCP server is the relevant one.

**Trust signal:** Genuinely first-party — under the `upstash` org, npm package published by an `@upstash.com` maintainer, ~62k stars, actively released (v4.x in Aug 2026).

**Red flags / surprises:** Not injection-y, and low blast radius (read-only docs). The one real caveat is the **outside dependency**: it **cannot be made fully local**, and it **sends your query terms to Context7's servers**. That's a mild trust/privacy boundary — perfectly fine for public open-source library names, but it should **not** be used where the library/topic name itself is confidential (e.g. an internal/private package name for a confidential project). Mirror the §36 / ADR 005 privacy stance: public-code use only.

**How it slots into Jarvis:** An **MCP connector** that needs an **outbound connection to context7.com** (and, optionally, a key). So it's a broker connection, not a purely-local skill — it crosses a (small) trust boundary and needs the one-time approval any new outbound connection needs.

**Verdict:** **SAFE, but needs approval for the outbound connection** (and optionally a free key). Restrict it to public/non-confidential library lookups — it can't be self-hosted, so query terms will leave the box.

---

## Bottom line

| Skill | Verdict | Version to pin | Needs a key? |
|---|---|---|---|
| **Anthropic `docx`/`pdf`/`pptx`/`xlsx`** | SAFE as-is — *use only, don't fork/modify/redistribute* (proprietary license) | commit `41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f` (no releases) | No (local; needs pandoc/LibreOffice/Poppler installed) |
| **Anthropic `skill-creator`** | SAFE as-is (Apache-2.0); runs code + spawns Claude subprocesses | commit `41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f` (no releases) | No (uses existing Claude auth; no new key) |
| **Firecrawl CLI (`firecrawl/cli`)** | SAFE, but stand up the self-hosted engine first; gate `interact`/`agent` sub-skills higher | CLI `v1.23.3` (sha `86aaf06…`); engine pinned separately (e.g. server `v2.11.0`) | No when self-hosted (auth auto-skipped) |
| **browser-use** | NEEDS A CLOSER LOOK — own LLM loop bypasses router/broker; overlaps planned Playwright MCP; cloud does CAPTCHA-solving | `0.13.8` (2026-08-16) | Yes — needs an LLM API key to work |
| **Context7 (`upstash/context7`)** | SAFE, but needs approval for the outbound connection; public-code use only | `@upstash/context7-mcp@4.0.4` | Optional (keyless works; free key raises limits) |

**Licenses at a glance:** Anthropic doc skills = **proprietary/source-available** (use-in-Services only, no forking). skill-creator = **Apache-2.0**. Firecrawl CLI = **ISC**; self-hosted Firecrawl engine = **AGPL-3.0** (fine internally). browser-use = **MIT**. Context7 = **MIT**. No non-commercial or otherwise business-hostile license in the batch — the only one to actually watch is the **Anthropic doc-skill "don't extract/fork/redistribute" restriction.**

---

## What I could NOT verify (be explicit)

- **GitHub "Verified" domain badges.** GitHub shows a checkmark next to an org when it verifies its domain, but that badge is stripped when the page is converted to text for automated reading, so I could not machine-confirm it for any of the four orgs. Instead, identity was confirmed by: the repo sitting under the expected canonical org namespace, the npm publisher's email domain (`@upstash.com`, `sideguide.dev`), star counts consistent with the real projects, and cross-links from each vendor's own docs/blog. Confidence is high on all four, but the literal "verified" pixel was not observed.
- **Release dates via the page summarizer were unreliable** (an early fetch misread years as 2023–2024). The dates in this doc were taken from the **GitHub/npm JSON APIs** instead (e.g. browser-use `0.13.8` → `2026-08-16`), which are authoritative; treat any date *not* sourced from the API as approximate.
- **Full file-by-file audit of every script.** I read the frontmatter and instructions and one representative script/skill per repo (e.g. `firecrawl-scrape/SKILL.md`, `docx/SKILL.md`, the license files). I did **not** read every helper script in every skill. Recommend a final line-by-line pass of the actual scripts at the moment we pin each version, since pinning is exactly when the bytes matter.
- **Firecrawl `firecrawl/cli` root LICENSE file** returned 404 on the raw path; the license (**ISC**) was confirmed from the authoritative npm registry metadata instead.
- **The exact self-hosted Firecrawl engine version** to pin is a separate decision from the CLI version and depends on which server release we deploy — verify against `firecrawl/firecrawl` releases at deploy time.

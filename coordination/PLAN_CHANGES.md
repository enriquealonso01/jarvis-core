# Plan changes — requirement intake log

Written only by the Requirements session (Enrique + Claude). Append-only.
Builder and Tester read this every loop to notice what changed in the plan.

Format per entry:
`YYYY-MM-DD  —  <what Enrique asked for>  —  steps touched: <S.. / new step>  —  affects already-built: yes/no (if yes, Builder rebuilds + Tester re-verifies)`

---

2026-09-03  —  Live browser voice UI: a "Talk to Jarvis" button beside "Ask Jarvis" that opens a full-duplex in-app call with an audio-driven moving-circle orb, same capabilities as WhatsApp/phone (reuses the S21 runtime; browser is a new transport + UI, not a second conversation brain).  —  steps touched: new S49 (references S19–S24, S39, IV.0/0.45; not edited)  —  affects already-built: no

2026-09-03  —  Jarvis places outbound calls to a third party to complete a task (e.g. "call this restaurant, book Saturday 8pm for two; come back if there's a problem"). Finding the place is S32; this is the call that acts on the pick.  —  steps touched: new S50 (reuses S23 dialer, S32 browser, S42 external-impact approval, S10 grants, S21 runtime, S41 disclosure; those steps not edited)  —  affects already-built: no

2026-09-03  —  Home is too dense and scrolls: make it a single no-scroll map of the whole system (a node-link "constellation" of projects, memory, running work, needs-you; build-progress bar stays), with all detail one click away. Every point bound to a real object; motion only on real state change (I.3 / 0.45) — not a movie prop.  —  steps touched: new S51 (revises S13's Home layout; keeps S13b bar; applies S15/I.3; adds back-ref banner to S13)  —  affects already-built: YES — Builder rebuilds Home, Tester re-verifies S13/S13b on the box

2026-09-03  —  "Jarvis must have access to everything and grow its own capabilities — infinite capabilities, smart and forthcoming, like Iron Man's Jarvis." State the missing founding PRINCIPLE: access-to-everything + self-extension, reconciled with the isolation spine (broad reach is safe *because* of the walls; the one thing it can't do alone is ship its own control plane; paying for things is a future spend-ceiling-with-approval, not now).  —  steps touched: Part 0 — 0.3 gains a 4th property "It grows"; new §0.35 (ties together existing S16/S31/S43/S44/S46). Additive principle, no built contract changed.  —  affects already-built: no

2026-09-03  —  Forthcoming behaviour: Jarvis asks for what it needs BEFORE a task is blocked (a key over WhatsApp, a tappable sign-in), proposes capabilities with one-tap approve, writes+registers its own reusable skills; and a scheduled call opens with its prepared purpose ("you asked me to call about X — where do you want to start?"), not a blank greeting. Bounded by S33's reasons list so it never nags.  —  steps touched: new S52 (reuses S16/S44/S46/S31; references S23 scheduled-call subject; not edited)  —  affects already-built: no

2026-09-03  —  Agent orchestration / powerhouse engineering: told in plain language ("spawn a planner that loops until the plan is solid, then a builder that loops and starts building"), Jarvis runs many cooperating agents on one goal — concurrent worktrees/branches, coordinating through recorded state, loops driven by a done-condition not a clock. Governed: ADR 007 leasing + concurrency ceiling, spend ceiling, watchdog, one kill switch; every agent inside the project's lines; none can ship core alone.  —  steps touched: new S53 (reuses S5/S6/S9/S28/S11; generalises S9's two-role case)  —  affects already-built: no

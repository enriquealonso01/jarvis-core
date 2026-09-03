# Plan changes — requirement intake log

Written only by the Requirements session (Enrique + Claude). Append-only.
Builder and Tester read this every loop to notice what changed in the plan.

Format per entry:
`YYYY-MM-DD  —  <what Enrique asked for>  —  steps touched: <S.. / new step>  —  affects already-built: yes/no (if yes, Builder rebuilds + Tester re-verifies)`

---

2026-09-03  —  Live browser voice UI: a "Talk to Jarvis" button beside "Ask Jarvis" that opens a full-duplex in-app call with an audio-driven moving-circle orb, same capabilities as WhatsApp/phone (reuses the S21 runtime; browser is a new transport + UI, not a second conversation brain).  —  steps touched: new S49 (references S19–S24, S39, IV.0/0.45; not edited)  —  affects already-built: no

2026-09-03  —  Jarvis places outbound calls to a third party to complete a task (e.g. "call this restaurant, book Saturday 8pm for two; come back if there's a problem"). Finding the place is S32; this is the call that acts on the pick.  —  steps touched: new S50 (reuses S23 dialer, S32 browser, S42 external-impact approval, S10 grants, S21 runtime, S41 disclosure; those steps not edited)  —  affects already-built: no

2026-09-03  —  Home is too dense and scrolls: make it a single no-scroll map of the whole system (a node-link "constellation" of projects, memory, running work, needs-you; build-progress bar stays), with all detail one click away. Every point bound to a real object; motion only on real state change (I.3 / 0.45) — not a movie prop.  —  steps touched: new S51 (revises S13's Home layout; keeps S13b bar; applies S15/I.3; adds back-ref banner to S13)  —  affects already-built: YES — Builder rebuilds Home, Tester re-verifies S13/S13b on the box

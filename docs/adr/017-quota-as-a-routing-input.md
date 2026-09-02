# ADR 017 — Quota is a routing input, and the model list is cut to what serves

- **Status:** Accepted
- **Date:** 2026-09-02
- **Step:** S25
- **Supersedes in part:** the routing section of `docs/INITIAL_MODEL_ROUTING.md`

## Context

S25 asks for two things that the code contradicted.

First, the plan corrects itself: "the plan has been treating a subscription
limit as an error — park the task and notify. That is wrong." `resolveProfile`
in `src/runner.ts` was literally `id = 'anthropic_personal'`. One engine,
hardcoded, parking the moment it was rate-limited, with two other subscriptions
and a hosted route registered and never consulted.

Second, "cut to what is real". The registry held five routes that were
`degraded` and had served nothing between them, and the supervisor chain was
four deep when the traffic showed one route serving 52 of 62 recorded calls.

## Decisions

### 1. Quota lives on the auth profile, and every figure says where it came from

`auth_profiles.quota_json` has existed since migration 001 with nothing writing
it. It now holds `{status, remaining_pct, estimated, resets_at, source, detail,
observed_at}`, and `quota_observations` keeps the evidence behind each write.

**No subscription here exposes a usage API.** Every number is therefore inferred
from an observed 429 and carries `estimated: true`. The plan's warning is the
reason: "a confident wrong quota figure is worse than an honest unknown, because
it will route around an engine that was actually available." Where the provider
gives a reset time it is used; where it does not, `ASSUMED_RESET_MS` (5 hours,
the shortest window any of the three publishes) is used and marked estimated.

The reset is applied **on read**, not by a sweep — a background job that clears
expired quota is a second place for the truth to live.

### 2. Isolation is checked before quota

`engineerLadder` asks `checkProfileAccess` first. A profile the project may not
use is not a busy fallback, it is not a candidate — and asking about quota first
produces a park message blaming a quota for a decision isolation had made.

### 3. Existing allowlist access is written down, not changed

The broker fails closed (S12) and `auth_profile_allowlists` was empty, so making
the ladder consult it would have parked every heavy task everywhere. Migration
028 inserts explicit rows for the three subscription logins × every project that
existed at that moment, scoped to `senior_engineer`.

This changes nothing about who can use what today — nothing consulted the
allowlist for these profiles before. What it changes is the direction: **a
project created after this migration gets no row until someone grants one.**
S26's onboarding asks "which auth profiles may see this data", which is where
those rows should come from. Narrowing an existing grant is now a row deletion
rather than a code change.

### 4. A spent engine requeues; it does not consume the retry budget

The retry budget counts attempts against one engine. Moving to a different
engine is not a retry of the same thing. What bounds the loop is the ladder
itself: each exhausted profile is skipped on the next pass, so there are at most
as many requeues as there are engines, and then it parks — naming which engines
are spent and when each returns.

`failures.ts` gained `quota` on the verdict to separate "this subscription is
spent" (comes back by itself) from "this credential is invalid" (comes back only
when Enrique acts). Auto-healing the second would fail forever, quietly.

### 5. Two ceilings, because one number cannot do both jobs

- **Soft** (default 80% of hard): exactly one notification per month, claimed by
  `model_policy.soft_notified_month`. Routing is unchanged.
- **Hard**: metered routes drop out of `routesForRole` **and** are refused at the
  broker as `budget.ceiling`. Subscription work carries on, because the ceiling
  bounds money and a flat-rate subscription costs the same idle. The plan is
  explicit that "a test that only proves metered calls stopped would pass on an
  implementation that stopped everything."

`budget.ceiling` is a third `Denial.code` rather than an isolation code, so the
audit row says which kind of refusal it was and `recordDenial` does not file it
as a security incident.

### 6. The engineering fallback has a name

`accounts/fireworks/models/kimi-k2p7-code`, chosen from the **live Fireworks
catalogue** (listed with the stored key, not guessed) against the plan's four
criteria: open weights (`moonshotai/Kimi-K2.7-Code` on HuggingFace), the
provider's own description naming long-horizon coding and tool use,
`supports_tools: true`, 262,144-token context, and $0.95 in / $4.00 out per
Mtok — roughly $0.62 for a long agentic run, against a $25 monthly ceiling.
Kimi K3 was the other candidate at $3.00/$15.00: one frontier run could take a
tenth of the month, which is a fallback that runs once.

It is registered `discovered`. It becomes routable when the probe has made a
real tool-enabled call against it, and not before.

### 7. The reviewer comes from a different family than the implementer

`accounts/fireworks/models/glm-5p3` sits ahead of the Claude reviewer, so
whichever engine writes the diff, the reviewer is not from its family (VI.3).
The plan's own fallback for this was "a second Claude context", which is the
letter of independent review without its purpose. S29 benchmarks the role
properly; this is the starting order, not the verdict.

### 8. Routes declare their executor

`model_registry.harness` (`claude_code`, `codex`, `cursor_acp`, `http_agent`).
The runner spawned `claude` for every route while `resolveProfile` accepted any
subscription profile the task named — so a task pinned to `cursor_personal`
would have launched the Claude CLI against a Cursor config directory. Only
`claude_code` is implemented; the rest wait on S28 and are skipped **with that
reason**, never counted as busy. The fake harness stands in for the vendor CLIs
but deliberately **not** for `http_agent`: there is no agent loop around a chat
model yet, and letting the fake pretend otherwise would produce a green test for
the one rung the plan warns will turn out to be a phrase.

### 9. The dead chain is cut in two places

`CANDIDATES` in `src/catalog.ts` is re-applied by every catalog verification, so
a row deleted only by migration returns within the hour. Both were edited. The
plan's own Debug note predicted this: "if a supposedly deleted provider still
appears, something is re-seeding it on boot."

Kept deliberately: `google/gemini-3.6-flash` is the only vision route and
`nvidia/nemotron-3-embed-1b` the only embeddings route. Deleting the last route
for a role does not simplify the chain, it empties it.

## Consequences

- A coding task survives its primary engine being spent, silently.
- Quota figures in the console are honest about being estimates.
- New projects must be granted engineer access explicitly. If onboarding does
  not do this by S26, projects created in between will park with "not
  allowlisted for this project" — which is the correct failure, but it needs the
  grant path to exist.
- The hosted engineering fallback is registered and priced but **cannot run**
  until S28 provides an executor. It is not a phrase, but it is not yet a rung.

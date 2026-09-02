#!/usr/bin/env node
/**
 * Rebuild PROGRESS.json from the plan, preserving the states we already know.
 *
 *   node scripts/progress-sync.mjs                    # refresh titles/count
 *   node scripts/progress-sync.mjs S5 partial "..."   # set one step's state
 *
 * total_steps is DERIVED by counting `^## S<n> — ` every time. The plan is
 * still growing — it was 30 steps, it is 37 now — and a hardcoded denominator
 * silently goes stale, which turns the bar into a number that flatters us.
 *
 * States: not_started | in_progress | partial | blocked | done
 * When two states are arguable, the lower one is correct.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const PLAN = "docs/JARVIS_MASTER_PLAN_V2.md";
const OUT = "PROGRESS.json";
const VALID = new Set(["not_started", "in_progress", "partial", "blocked", "done"]);

const plan = fs.readFileSync(PLAN, "utf8").split(/\r?\n/);
const steps = [];
let stage = 0;
for (const line of plan) {
  const s = /^# STAGE (\d+)/.exec(line);
  if (s) { stage = Number(s[1]); continue; }
  // S13b and S18b are real steps with their own Done when lines, and the old
  // pattern skipped them: `S\d+` does not match "S18b". So `progress-sync S18b
  // done` silently updated nothing, and the denominator was two short — the
  // exact "flattering lie" the derived total_steps exists to prevent.
  const m = /^## (S\d+[a-z]?) — (.+?)\s*$/.exec(line);
  if (m) steps.push({ id: m[1], title: m[2], stage });
}
if (!steps.length) {
  console.error("no steps found in the plan — refusing to write a zero denominator");
  process.exit(1);
}

const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { steps: [] };
const known = new Map((prev.steps ?? []).map((s) => [s.id, s]));

const [, , setId, setState, ...rest] = process.argv;
if (setId) {
  if (!VALID.has(setState)) {
    console.error(`state must be one of: ${[...VALID].join(", ")}`);
    process.exit(1);
  }
  const cur = known.get(setId) ?? { id: setId };
  known.set(setId, { ...cur, state: setState, evidence: rest.join(" ") || cur.evidence });
}

const merged = steps.map((s) => {
  const k = known.get(s.id) ?? {};
  return {
    id: s.id,
    title: s.title,
    stage: s.stage,
    state: k.state ?? "not_started",
    ...(k.pr ? { pr: k.pr } : {}),
    ...(k.evidence ? { evidence: k.evidence } : {}),
    ...(k.blocker ? { blocker: k.blocker } : {}),
  };
});

const planSha = execFileSync("git", ["log", "-1", "--format=%H", "--", PLAN]).toString().trim();
// What is being worked on NOW, in order of how much it is being worked on. A
// `partial` step waiting on Enrique used to win over the step actually in
// progress, so the bar said "S12" while S13 was being built — which is the one
// number on the page Enrique reads at a glance.
const firstOpen = merged.find((s) => s.state === "in_progress")
  ?? merged.find((s) => s.state === "partial")
  ?? merged.find((s) => s.state !== "done" && s.state !== "blocked");

const gates = { ...(prev.gates ?? {}) };
for (let g = 1; g <= 7; g += 1) if (!gates[g]) gates[g] = "pending";

const out = {
  plan_file: PLAN,
  plan_sha: planSha,
  total_steps: merged.length,
  updated_at: new Date().toISOString(),
  current_step: firstOpen ? firstOpen.id : merged[merged.length - 1].id,
  steps: merged,
  gates,
};
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
const tally = merged.reduce((a, s) => ({ ...a, [s.state]: (a[s.state] ?? 0) + 1 }), {});
console.log(`PROGRESS.json: ${merged.length} steps, current ${out.current_step}`, tally);

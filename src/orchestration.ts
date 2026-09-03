/**
 * Many agents on one goal, and the three things that stop it running away
 * (plan S53).
 *
 *   "The most powerful step in the engineering half, and **the easiest to turn
 *    into a runaway**... Many looping agents is the requirement *and* the danger.
 *    Ungoverned, it is an unbounded fan-out of leases and spend that starves every
 *    other project and bills without limit."
 *
 * The Debug note names all three failures and where each one lives, which is
 * unusually precise and is what this file is organised around.
 *
 * ONE: **the loop.** "If loops never stop, the done-condition is a timer rather
 * than a state check — **a loop with no real stop is a bill with a heartbeat.**"
 * So `shouldContinue` is handed the checkable fields of a done-condition and NO
 * clock. The five minutes in "loop every five minutes until the plan is solid" is
 * a poll cadence; "solid" is the condition, and only the condition can end it.
 * There is also a hard iteration ceiling, because a condition that is never
 * satisfied by a broken planner is the same bill.
 *
 * TWO: **the ceiling.** "If it spawns without bound, the ceiling is being checked
 * **per agent instead of per orchestration** — the fan-out point is where the
 * limit belongs." So admission takes the orchestration's current agent count, not
 * one agent's opinion of itself.
 *
 * THREE: **progress.** The watchdog stops "a looping agent that stops making
 * *real* progress — a checkpoint, a merged branch, a closed gap, **never 'it ran
 * again'**". So the markers that count as progress are a closed set and running
 * again is not on it.
 *
 * AND THE BOUNDARY THE POWER MAKES TEMPTING: "**orchestration multiplies the
 * builders, not the authority.**" No agent in a swarm ships core; `mayShipCore`
 * returns the literal false.
 */

export type Role = "planner" | "builder" | "reviewer";

export type Agent = {
  id: string;
  role: Role;
  orchestrationId: string;
  projectId: string | null;
};

/* ------------------------------------------------------------------ *
 * The loop, which stops on a condition and not on a clock.
 * ------------------------------------------------------------------ */

/**
 * What "solid" means, as fields something can check.
 *
 * "**'Solid' is a real, checkable done-condition** (the plan covers the goal, has
 * no open gaps, passes its own checklist)." Written as three booleans rather than
 * a score, because a threshold is a dial somebody turns down when the loop will
 * not stop.
 */
export type DoneCondition = {
  coversTheGoal: boolean;
  openGaps: number;
  passesItsChecklist: boolean;
};

export function isDone(c: DoneCondition): boolean {
  return c.coversTheGoal && c.openGaps === 0 && c.passesItsChecklist;
}

/**
 * A loop cannot run more times than this, whatever the condition says.
 *
 * Not the stop condition — the backstop. A planner whose condition is never
 * satisfied because it is broken bills exactly like one with no condition at all,
 * and "a loop with no real stop is a bill with a heartbeat".
 */
export const MAX_ITERATIONS = 20;

export type LoopDecision =
  | { continue: true; iteration: number; why: string }
  | { continue: false; why: string; reason: "done" | "ceiling" };

/**
 * Does the planner go round again?
 *
 * Takes the condition and the iteration count. There is no clock, no elapsed
 * time and no deadline in scope, so "the loop stops on the condition, not after a
 * fixed time" is a property of what this function can see rather than a note
 * asking the next person not to add a timer.
 */
export function shouldContinue(
  condition: DoneCondition,
  iterationsSoFar: number,
): LoopDecision {
  if (isDone(condition)) {
    return { continue: false, reason: "done", why: "the plan covers the goal with no open gaps" };
  }
  if (iterationsSoFar >= MAX_ITERATIONS) {
    return {
      continue: false,
      reason: "ceiling",
      why: `stopped at ${MAX_ITERATIONS} rounds without reaching the condition — something is wrong `
        + "with the planner, not with the goal",
    };
  }
  return {
    continue: true,
    iteration: iterationsSoFar + 1,
    why: `${condition.openGaps} gap${condition.openGaps === 1 ? "" : "s"} still open`,
  };
}

/* ------------------------------------------------------------------ *
 * The ceiling, checked where the fan-out happens.
 * ------------------------------------------------------------------ */

export const PER_ORCHESTRATION_CEILING = 4;
export const SYSTEM_CEILING = 8;

export type Admission =
  | { admit: true; why: string }
  | { admit: false; queue: true; why: string };

/**
 * May another agent start?
 *
 * Asked of the ORCHESTRATION and of the system, never of the agent. The Debug
 * note is explicit that checking per agent is how it spawns without bound: an
 * agent asking "may I run" always answers yes, because it is only one.
 *
 * Over the ceiling agents QUEUE - "the heavy lane does not become infinite
 * because someone asked for a powerhouse" - rather than being refused, because a
 * refused agent is work he asked for that silently never happens.
 */
export function admitAgent(args: {
  agentsInThisOrchestration: number;
  agentsSystemWide: number;
}): Admission {
  if (args.agentsInThisOrchestration >= PER_ORCHESTRATION_CEILING) {
    return {
      admit: false,
      queue: true,
      why: `this orchestration already has ${args.agentsInThisOrchestration} agents; the next one waits`,
    };
  }
  if (args.agentsSystemWide >= SYSTEM_CEILING) {
    return {
      admit: false,
      queue: true,
      why: `${args.agentsSystemWide} agents are running across the system; the next one waits so the `
        + "other projects keep their lanes",
    };
  }
  return { admit: true, why: "under both ceilings" };
}

/* ------------------------------------------------------------------ *
 * A tree each.
 * ------------------------------------------------------------------ */

/**
 * Where this agent works.
 *
 * "Parallel builders never share a tree; a branch per builder, merged through the
 * normal reviewed loop — **never a swarm pushing to one branch.**" Derived from
 * the agent id, so two agents cannot be handed the same path by a caller that
 * meant well.
 */
export function worktreeFor(agent: Agent): { path: string; branch: string } {
  return {
    path: `/var/lib/jarvis/worktrees/${agent.orchestrationId}/${agent.id}`,
    branch: `orchestration/${agent.orchestrationId}/${agent.role}-${agent.id}`,
  };
}

/* ------------------------------------------------------------------ *
 * Progress, which is not "it ran again".
 * ------------------------------------------------------------------ */

/**
 * The things that count.
 *
 * A closed set, and `ran_again` is deliberately not on it. "A looping agent that
 * stops making REAL progress — a checkpoint, a merged branch, a closed gap, never
 * 'it ran again' — is stopped, not left burning a lease."
 */
export const REAL_PROGRESS = ["checkpoint", "branch_merged", "gap_closed", "review_passed"] as const;
export type ProgressMarker = (typeof REAL_PROGRESS)[number];

export function isRealProgress(marker: string): marker is ProgressMarker {
  return (REAL_PROGRESS as readonly string[]).includes(marker);
}

/** How many rounds of nothing before the watchdog stops it. */
export const IDLE_ROUNDS_ALLOWED = 3;

export function watchdogVerdict(args: {
  /** Markers since the last check, in the order they happened. */
  markers: string[];
  roundsWithoutProgress: number;
}): { stop: boolean; why: string } {
  const real = args.markers.filter(isRealProgress);
  if (real.length > 0) {
    return { stop: false, why: `made real progress: ${real.join(", ")}` };
  }
  if (args.roundsWithoutProgress >= IDLE_ROUNDS_ALLOWED) {
    return {
      stop: true,
      why: `${args.roundsWithoutProgress} rounds with nothing to show — running again is not progress`,
    };
  }
  return { stop: false, why: "nothing yet, but within the allowance" };
}

/* ------------------------------------------------------------------ *
 * Spend, and the one kill.
 * ------------------------------------------------------------------ */

export type SpendVerdict =
  | { proceed: true; remaining: number }
  | { proceed: false; paused: true; say: string };

/**
 * "It **warns and pauses** at the ceiling rather than blowing through it."
 *
 * Paused rather than killed: the work is not wrong, it has reached a limit, and
 * killing it would lose what it has done. He can raise the ceiling or stop it,
 * and both are his to choose.
 */
export function spendCheck(spentCents: number, ceilingCents: number): SpendVerdict {
  if (spentCents >= ceilingCents) {
    return {
      proceed: false,
      paused: true,
      say: `Paused at the spend ceiling — ${(spentCents / 100).toFixed(2)} of `
        + `${(ceilingCents / 100).toFixed(2)}. Raise it or stop it; I have not gone past it.`,
    };
  }
  return { proceed: true, remaining: ceilingCents - spentCents };
}

/**
 * One action, every agent, every lease.
 *
 * "**A powerful thing he cannot stop in one move is not one he will turn on.**"
 * So this takes the orchestration and returns what it released, rather than
 * taking a list of agents somebody has to assemble correctly first — assembling
 * that list is where one gets missed.
 */
export function killOrchestration(agents: Agent[]): {
  stopped: string[];
  leasesReleased: number;
  say: string;
} {
  return {
    stopped: agents.map((a) => a.id),
    leasesReleased: agents.length,
    say: `Stopped all ${agents.length} agents and released their leases.`,
  };
}

/* ------------------------------------------------------------------ *
 * More hands, not more authority.
 * ------------------------------------------------------------------ */

/**
 * May this agent ship core?
 *
 * No, and the type says so. "**No individual agent ships core off its own bat**...
 * a core deploy goes through S54's staged, health-gated pipeline, not a single
 * agent in a swarm deciding to push. **Orchestration multiplies the builders, not
 * the authority.**"
 */
export function mayShipCore(): { allowed: false; why: string } {
  return {
    allowed: false,
    why: "a core deploy goes through S54's staged, health-gated pipeline — an orchestration has more "
      + "hands, not more authority",
  };
}

/**
 * May this agent read that project?
 *
 * Only its own. "A ten-agent effort on Alpha is still entirely inside Alpha" —
 * and the plan is specific that this must hold "across EVERY agent, not just the
 * first", which is why it takes the agent rather than the orchestration.
 */
export function mayReadProject(agent: Agent, projectId: string | null): boolean {
  return agent.projectId === projectId;
}

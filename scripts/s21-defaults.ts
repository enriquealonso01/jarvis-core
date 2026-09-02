/**
 * Print the turn-shape budgets this build ships with.
 *
 * Run in its own process with `JARVIS_TURN_SCALE` unset, so the numbers are the
 * ones a real call gets rather than the shrunken ones the suite runs at.
 */
import { TURN_MS } from "../src/callruntime.js";
console.log([TURN_MS.ack, TURN_MS.checking, TURN_MS.progress, TURN_MS.budget].join(","));

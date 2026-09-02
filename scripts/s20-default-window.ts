/**
 * Print the endpoint window this build ships with.
 *
 * Run in its own process with `JARVIS_ENDPOINT_MS` unset, so the number it
 * prints is the default a real call gets — not the shortened one the suite runs
 * at. Asserting the default from inside a process that has already overridden it
 * is how a test comes to prove nothing.
 */
import { BUDGET_MS } from "../src/callstate.js";
console.log(String(BUDGET_MS.endpoint));

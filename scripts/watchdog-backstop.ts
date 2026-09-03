/**
 * The backstop that runs outside the container (plan II.3).
 *
 *   node --import tsx scripts/watchdog-backstop.ts
 *
 * The watchdog lives in the `worker` container. The API, which also reads its
 * sweep record, lives in a container too. If whatever stops one stops the
 * other - the docker daemon, the host running out of memory, a bad compose
 * change - then both readers are gone and the silence is complete.
 *
 * So the last reader is a host timer. It needs no application state beyond a
 * database connection, it cannot be starved by whatever starved the watchdog,
 * and it is deliberately dull: read the sweep record, open or close one
 * incident, print one line, exit.
 *
 * It does not restart anything. A backstop that takes action is a second
 * watchdog and needs a third.
 */
import { createPool } from "../src/db.js";
import { reconcileSweepIncident, sweepHealth } from "../src/selfwatch.js";

const pool = createPool();

async function main(): Promise<void> {
  const health = await sweepHealth(pool, "watchdog");
  const action = await reconcileSweepIncident(pool, health, "host-timer");
  console.log(
    `${health.detail}${health.owner ? ` (owner ${health.owner}, ${health.sweeps} sweeps)` : ""}`
    + `${action === "unchanged" ? "" : ` - incident ${action}`}`,
  );
  // Non-zero when stale, so `systemctl status` and the journal show a failed
  // unit rather than a successful one whose output nobody reads.
  if (health.stale) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(`backstop failed: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 2;
  })
  .finally(async () => { await pool.end().catch(() => undefined); });

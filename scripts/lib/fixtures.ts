/**
 * Cleanup that happens even when the suite fails.
 *
 * Every S30 suite removed its fixture project on the happy path only. A thrown
 * assertion, or an early exit, left the project standing - and a leftover
 * project is not inert here. Stage B routing re-homes an inbox event into a
 * matching project, so a fixture that outlives its suite becomes a live routing
 * target for the next one: that is exactly how s37-untrusted-test came to fail
 * for two ticks against six innocent commits.
 *
 * Two rules, both learned by breaking them:
 *
 *  - cleanup belongs in a `finally`, because the runs that leave litter are the
 *    ones that failed, and those are precisely the runs that skip the tidy-up
 *    at the bottom of `main`;
 *  - removal goes through `teardownFixtureProject`, which is transactional and
 *    walks the foreign keys. Hand-rolled DELETEs in the wrong order are what
 *    left the litter in the first place, and a half-deleted project is worse
 *    than an untouched one because it looks fine until something uses it.
 */
import type pg from "pg";
import { teardownFixtureProject } from "./fixture.js";

/**
 * Remove every project a suite created, and say so when one will not go.
 *
 * Never throws: it is called from a `finally`, and a cleanup that throws would
 * replace the real failure with its own, hiding the thing the suite was
 * actually reporting.
 */
export async function removeFixtures(pool: pg.Pool, ids: (string | null | undefined)[]): Promise<void> {
  for (const id of ids) {
    if (!id) continue;
    const out = await teardownFixtureProject(pool, id).catch((e: unknown) => {
      console.log(`  cleanup: project ${id.slice(0, 8)} NOT removed - ${e instanceof Error ? e.message.slice(0, 110) : e}`);
      return null;
    });
    if (out && out.leftBehind.length) {
      console.log(`  cleanup: project ${id.slice(0, 8)} left ${JSON.stringify(out.leftBehind)}`);
    }
  }
}

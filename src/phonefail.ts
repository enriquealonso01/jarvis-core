/**
 * Which provider is being forced to fail on the phone path.
 *
 * Its own module so both the carrier layer (`callcontrol`) and the turn runtime
 * (`callruntime`) can read it without importing each other. Set by nothing in
 * production; the failure modes it stands in for — bad key, unroutable
 * endpoint, 500 — all arrive as the same thing, no usable answer, and what the
 * tests are about is the spoken fallback rather than the status code.
 */
export function phoneFailing(what: string): boolean {
  return (process.env.JARVIS_PHONE_FAIL ?? "").split(",").includes(what);
}

/**
 * Score a run out of 1.
 *
 * `parts` holds a value per dimension. `correct` is whether the run actually
 * did the thing; the rest describe how tidily it went about it. `cost` is the
 * tokens it spent, recorded alongside the rest.
 *
 * A dimension may be null when it could not be determined.
 */
export function score(parts) {
  const values = Object.values(parts).map((v) => (v === null ? 0 : v));
  const total = values.reduce((a, b) => a + b, 0);
  return total / values.length;
}

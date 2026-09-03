/**
 * Score a run out of 1.
 *
 * `parts` holds a value per dimension. `correct` is whether the run actually
 * did the thing; the rest describe how tidily it went about it. `cost` is the
 * tokens it spent, recorded alongside the rest.
 *
 * A dimension may be null when it could not be determined.
 *
 * Three things the flat average got wrong, and this reference fix gets right:
 *
 *  - Whether the run did the thing is worth more than how tidily it went about
 *    it, so `correct` carries the weight of the three process dimensions
 *    together. Capping the result when `correct` is 0 would answer the reported
 *    complaint and still let a token count dominate everything else.
 *  - `cost` is recorded, never scored. Averaged in, a cheap wrong run beats a
 *    costly right one, and a raw token count dwarfs terms that live in 0..1.
 *  - A dimension that could not be determined is excluded along with its
 *    weight. Counting it as zero ranks two runs by whether something happened
 *    to be measurable, which is a property of the harness, not the work.
 */
const WEIGHTS = { correct: 3, tidy: 1, scoped: 1, reported: 1 };

export function score(parts) {
  let weighted = 0;
  let total = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    const v = parts[k];
    if (v === null || v === undefined) continue;
    weighted += v * w;
    total += w;
  }
  return total === 0 ? 0 : weighted / total;
}

/**
 * Parse "1-5" into the list of numbers it names.
 * Also accepts a bare number, "7" -> [7].
 */
export function parseRange(text) {
  const s = String(text).trim();
  if (!s.includes("-")) {
    const n = Number(s);
    if (!Number.isInteger(n)) throw new Error(`not a range: ${text}`);
    return [n];
  }
  const [aRaw, bRaw] = s.split("-");
  const a = Number(aRaw);
  const b = Number(bRaw);
  if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`not a range: ${text}`);
  if (b < a) throw new Error(`backwards range: ${text}`);
  const out = [];
  for (let i = a; i <= b; i += 1) out.push(i);
  return out;
}

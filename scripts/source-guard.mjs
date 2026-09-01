// Refuse to ship source with defects that fail silently rather than loudly.
//
// A patch script wrote a literal backspace byte (0x08) where a regex `\b` was
// intended. It compiled, deployed, and read correctly in an editor, but the
// pattern could never match — the feature was dead on arrival and nothing said
// so. Anything that reaches a regex or a string literal this way is invisible
// in review, so it is checked mechanically instead.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "scripts", "migrations"];
// Tab, LF and CR are the only control characters source is allowed to contain.
const BAD = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

let failures = 0;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(ts|tsx|js|mjs|py|sql|sh)$/.test(entry)) continue;
    const text = readFileSync(full, "utf8");
    const lines = text.split(/\r?\n/);

    lines.forEach((line, i) => {
      const m = line.match(BAD);
      if (!m) return;
      const code = m[0].charCodeAt(0).toString(16).padStart(2, "0");
      console.error(`${full}:${i + 1}: control character 0x${code}`);
      failures += 1;
    });

    // A definition that silently shadows an earlier one of the same name.
    // The acceptance runner carried two copies of `test_upload_scan`; the later,
    // wasteful one won, so an improvement that had been written and reviewed
    // never actually ran. Nothing errored — which is what makes it worth a guard.
    const seen = new Map();
    let scope = 0;
    lines.forEach((line, i) => {
      // Two classes may each define `run`, so names are scoped to the class
      // they sit in rather than to the file.
      if (/^class\s+\w+/.test(line)) scope += 1;
      const py = line.match(/^(\s*)def\s+(\w+)\s*\(/);
      const js = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
      if (!py && !js) return;
      const key = py ? `${scope}:${py[1].length}:${py[2]}` : `fn:${js[1]}`;
      if (seen.has(key)) {
        console.error(
          `${full}:${i + 1}: duplicate definition shadows line ${seen.get(key)}`,
        );
        failures += 1;
        return;
      }
      seen.set(key, i + 1);
    });
  }
}

for (const root of ROOTS) {
  try {
    walk(root);
  } catch {
    // A root that does not exist in this checkout is not an error.
  }
}

if (failures > 0) {
  console.error(`source-guard: ${failures} problem(s) found — not shipping`);
  process.exit(1);
}
console.log("source-guard: clean");

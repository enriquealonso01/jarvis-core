/**
 * The DEBUG_NOTES index has to be followable, or the instruction to read it is
 * not an instruction.
 *
 * Every tick begins by reading that index and jumping to the section for
 * whatever is about to be touched. A note that is not in the index is a note
 * nobody will find, and an index entry that points at no section wastes the one
 * click somebody was willing to spend.
 *
 * Written after doing all three by hand in one sitting: adding five notes,
 * inserting a duplicate entry because my slug function dropped an underscore
 * GitHub keeps, and finding a duplicate that had been there for days.
 */
import fs from "node:fs/promises";
import path from "node:path";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const DOCS = process.env.JARVIS_DOCS_DIR ?? "docs";

/**
 * GitHub's anchor rules, which are narrower than they look.
 *
 * Letters, digits, underscores and hyphens survive; spaces become hyphens;
 * everything else is dropped. Two details cost me a wrong answer each: it keeps
 * UNDERSCORES, so `to_e164` is not `toe164`; and it does NOT collapse
 * consecutive hyphens, so "kill -TERM -1" gives "kill--term--1". A slugger that
 * gets either wrong reports working links as broken, which is worse than no
 * checker at all - it sends someone to fix what is not broken.
 */
export function githubSlug(title: string): string {
  return [...title.toLowerCase()]
    .filter((c) => /[a-z0-9 \-_]/.test(c))
    .join("")
    .replace(/ /g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main(): Promise<void> {
  const text = await fs.readFile(path.join(DOCS, "DEBUG_NOTES.md"), "utf8");
  const lines = text.split("\n");

  const sections = lines.filter((l) => l.startsWith("### ")).map((l) => l.slice(4).trim());
  const links = [...text.matchAll(/^- \[([^\]]+)\]\(#([^)]+)\)/gm)].map((m) => ({ title: m[1], anchor: m[2] }));

  console.log(`${sections.length} sections, ${links.length} index entries`);
  console.log("");

  sections.length > 50
    ? ok(`the file parsed: ${sections.length} sections`)
    : bad(`only ${sections.length} sections found - the heading level probably changed`);

  const anchors = new Set(sections.map(githubSlug));
  const linked = new Set(links.map((l) => l.anchor));

  const unindexed = sections.filter((s) => !linked.has(githubSlug(s)));
  unindexed.length === 0
    ? ok("every section is reachable from the index")
    : bad(`not in the index: ${unindexed.slice(0, 5).join(" | ")}`);

  const dangling = links.filter((l) => !anchors.has(l.anchor));
  dangling.length === 0
    ? ok("and every index entry points at a section that exists")
    : bad(`points nowhere: ${dangling.slice(0, 5).map((d) => d.anchor).join(", ")}`);

  const seen = new Map<string, number>();
  for (const l of links) seen.set(l.anchor, (seen.get(l.anchor) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([a]) => a);
  dupes.length === 0
    ? ok("with no entry listed twice")
    : bad(`listed more than once: ${dupes.join(", ")}`);

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

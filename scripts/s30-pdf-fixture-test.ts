/**
 * The PDF fixtures are real PDFs, and the extractor reads them.
 *
 * S30's N2 check asks for three PDFs. This box has no PDF generator, so the
 * fixtures are built by scripts/lib/minipdf.ts - and a fixture builder written
 * beside the parser is exactly the kind of thing that quietly tests nothing.
 * Two ways that goes wrong, both asserted here: the file is not actually a PDF
 * (a .txt with the wrong extension would sail through a pipeline that never
 * parses it), and the text survives the round trip only for short documents,
 * so the buried fact on page two is silently lost.
 *
 * What this does NOT claim: that the extractor handles PDFs from the wild.
 * These carry no compression, no embedded fonts and no columns. It proves the
 * plumbing - bytes on disk, through extractText, with the content intact.
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPdf } from "./lib/minipdf.js";
import { extractText, chunkKindFor } from "../src/extract.js";
import { chunkDocument } from "../src/chunk.js";

let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); pass += 1; };
const bad = (m: string, extra?: unknown) => {
  console.log(`  FAIL - ${m}${extra === undefined ? "" : `: ${String(extra).slice(0, 160)}`}`);
  fail += 1;
};

const BURIED = "the 7th is a bank holiday";

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "s30pdf-"));

  const lines = [
    "Vendor review - meeting notes",
    "",
    "The renewal quote came in at 4,200 EUR for the year.",
    ...Array.from({ length: 70 }, (_, i) => `Filler paragraph ${i + 1} about scope, staffing and timelines.`),
    `Decision: the cutover moves to the 14th, because ${BURIED}.`,
  ];

  const path = join(dir, "vendor-review.pdf");
  writeFileSync(path, buildPdf(lines));

  const raw = readFileSync(path);
  raw.subarray(0, 5).toString("latin1") === "%PDF-"
    ? ok("the file begins with a PDF header")
    : bad("not a PDF by its own header", raw.subarray(0, 12).toString("latin1"));
  raw.toString("latin1").includes("%%EOF")
    ? ok("and is terminated properly")
    : bad("no EOF marker");

  /*
   * More than one page on purpose. A single-page fixture would pass even if
   * the writer got the page tree wrong, and the fact this test cares about is
   * deliberately on the LAST page - the one a broken Kids array loses.
   */
  const pages = (raw.toString("latin1").match(/\/Type \/Page[^s]/g) ?? []).length;
  pages > 1 ? ok(`it has ${pages} pages, so the page tree is exercised`) : bad(`only ${pages} page`);

  const out = await extractText(path, "application/pdf");
  out.ok ? ok("the extractor reads it") : bad("extraction failed", out.reason);

  const text = out.text ?? "";
  text.includes("4,200")
    ? ok("text from the first page survives")
    : bad("lost the first-page figure");
  text.includes(BURIED)
    ? ok("and the fact buried on the last page survives too")
    : bad("lost the buried fact - the page tree or the stream length is wrong");

  /*
   * Through the chunker as well, because retrieval never sees extractText
   * output directly. A fact that survives extraction but lands in no chunk is
   * unfindable, which is the same outcome as never having ingested it.
   */
  const chunks = chunkDocument({ text, kind: chunkKindFor("application/pdf", "vendor-review.pdf") });
  chunks.length > 1 ? ok(`it chunks into ${chunks.length} pieces`) : bad(`chunked into ${chunks.length}`);
  chunks.some((c) => c.body.includes(BURIED))
    ? ok("and the buried fact lands inside a chunk")
    : bad("the fact survived extraction but no chunk contains it");

  console.log("");
  console.log(`==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

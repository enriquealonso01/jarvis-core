/**
 * S30 — getting text out of the three PDFs, and being honest about the ones
 * that cannot be read.
 *
 * The failure this guards is quiet by construction: a document that extracts to
 * an empty string is stored, indexed and permanently unanswerable, and looks
 * exactly like a document with nothing to say. So every assertion here is
 * either "the words came out" or "the reason came out".
 *
 * The PDF is generated rather than committed as a fixture, so the test exercises
 * a real parse of a real file rather than a string somebody pasted.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chunkKindFor, extractText } from "../src/extract.js";
import { chunkDocument } from "../src/chunk.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

/**
 * A minimal but genuinely valid PDF, written by hand.
 *
 * Building one this way keeps the test dependency-free in the direction that
 * matters: if it passed by using the same library to write and to read, it
 * would prove the library agrees with itself.
 */
function makePdf(line: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R"
      + " /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "s30-extract-"));

  console.log("1. a real PDF gives up its words");
  const pdfPath = path.join(dir, "contract.pdf");
  await fs.writeFile(pdfPath, makePdf("The refund window is fourteen days from delivery."));
  const pdf = await extractText(pdfPath, "application/pdf");
  pdf.ok ? ok("the PDF parsed") : bad(`the PDF did not parse: ${pdf.ok ? "" : pdf.reason}`);
  pdf.ok && pdf.text.includes("fourteen days")
    ? ok(`the sentence came out: "${pdf.ok ? pdf.text.trim().slice(0, 48) : ""}"`)
    : bad(`text was: ${pdf.ok ? JSON.stringify(pdf.text.slice(0, 80)) : "n/a"}`);

  console.log("");
  console.log("2. a file that cannot be read says why, rather than extracting to nothing");
  const scanned = path.join(dir, "scanned.pdf");
  await fs.writeFile(scanned, makePdf(""));
  const empty = await extractText(scanned, "application/pdf");
  !empty.ok && empty.reason.includes("scanned")
    ? ok("an image-only PDF is reported, not stored as an empty success")
    : bad(`an empty PDF returned ${JSON.stringify(empty).slice(0, 90)}`);

  const binary = path.join(dir, "photo.heic");
  await fs.writeFile(binary, Buffer.from([0, 1, 2, 3, 4]));
  const unsupported = await extractText(binary, "image/heic");
  !unsupported.ok && unsupported.reason.includes("no extractor")
    ? ok(`an unsupported format names itself: ${unsupported.ok ? "" : unsupported.reason}`)
    : bad("an unsupported format did not explain itself");

  const missing = await extractText(path.join(dir, "nope.txt"), "text/plain");
  !missing.ok && missing.reason.includes("no file")
    ? ok("and a missing file is a reason, not a crash")
    : bad("a missing file did not report cleanly");

  console.log("");
  console.log("3. text formats come through, and pick up the right chunking");
  const csv = path.join(dir, "invoices.csv");
  await fs.writeFile(csv, "id,client,amount\n1,acme,100\n2,globex,200\n");
  const table = await extractText(csv, "text/csv");
  table.ok && table.kind === "table"
    ? ok("a CSV is recognised as a table, so its header rides every chunk")
    : bad(`csv kind was ${table.ok ? table.kind : "error"}`);

  const src = path.join(dir, "slugify.ts");
  await fs.writeFile(src, "export function slugify(s: string) {\n  return s;\n}\n");
  const code = await extractText(src, null);
  code.ok && code.kind === "code"
    ? ok("a source file is recognised as code, so it is cut at symbols")
    : bad(`source kind was ${code.ok ? code.kind : "error"}`);

  console.log("");
  console.log("4. HTML is indexed as words, not as markup");
  const html = path.join(dir, "page.html");
  await fs.writeFile(html,
    "<html><head><style>.a{color:red}</style><script>function boom(){}</script></head>"
    + "<body><h1>Refund policy</h1><p>Fourteen&nbsp;days from delivery.</p></body></html>");
  const web = await extractText(html, "text/html");
  web.ok && web.text.includes("Fourteen days") && !web.text.includes("function boom")
    ? ok("tags and scripts are gone, the sentence is intact")
    : bad(`html text was: ${web.ok ? JSON.stringify(web.text.slice(0, 90)) : "error"}`);

  console.log("");
  console.log("5. extraction feeds chunking, so a PDF is retrievable end to end");
  if (pdf.ok) {
    const chunks = chunkDocument({ text: pdf.text, kind: pdf.kind });
    chunks.length >= 1 && chunks[0].body.includes("fourteen days")
      ? ok("the extracted text chunks into something that contains the answer")
      : bad("the extracted text did not survive chunking");
  }
  chunkKindFor("application/pdf", "a.pdf") === "prose"
    ? ok("and a PDF chunks as prose, on its headings")
    : bad("a PDF was classified as something else");

  await fs.rm(dir, { recursive: true, force: true });
  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

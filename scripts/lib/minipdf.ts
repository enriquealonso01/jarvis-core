/**
 * A minimal, real PDF writer - enough to make fixtures the extractor must parse.
 *
 * Written because this box has no PDF generator (no reportlab, no fpdf, no
 * pandoc, no LibreOffice) and S30's N2 check asks for three PDFs specifically.
 * The alternative was to feed the pipeline a .txt renamed to .pdf, which would
 * have tested everything except the thing that actually breaks: extraction.
 *
 * Deliberately uncompressed and structurally plain - a catalog, a pages node, a
 * page per chunk of lines, one Helvetica font, an uncompressed content stream.
 * That is a real PDF by the format's rules and pdf-parse reads it, but it is
 * not a stand-in for a PDF produced by a word processor: no compression, no
 * embedded fonts, no ligatures, no two-column layout. A fixture built by the
 * same hands as the parser proves the parser can read its own handwriting, so
 * the value here is in the plumbing - bytes on disk, through the extractor,
 * into chunks - not in claiming coverage of real-world PDFs.
 *
 * The xref offsets are computed from the assembled bytes rather than guessed;
 * an off-by-one there produces a file most readers accept and some reject, and
 * a fixture that only sometimes parses would be worse than none.
 */

/** Escape the three characters a PDF literal string cannot carry raw. */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function contentStream(lines: string[]): string {
  const body = lines.map((l) => `(${esc(l)}) Tj T*`).join("\n");
  return `BT\n/F1 11 Tf\n14 TL\n72 720 Td\n${body}\nET\n`;
}

/**
 * Build a PDF from lines of text, `perPage` of them to a page.
 *
 * Returns bytes, not a path: the caller decides whether this ever touches a
 * disk, which keeps the test that round-trips it honest about what it wrote.
 */
export function buildPdf(lines: string[], perPage = 44): Buffer {
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push([""]);

  // Object 1 catalog, 2 pages, 3 font, then a page object and a stream each.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  pages.forEach((p, i) => {
    const stream = contentStream(p);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]`
      + ` /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`);
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });

  const xrefAt = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(out, "latin1");
}

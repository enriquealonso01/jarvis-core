/**
 * Getting text out of what gets dumped in (plan S30).
 *
 * N2 is "a 40-message thread and three PDFs", so a pipeline that only handles
 * text handles two thirds of the sentence. What matters more than the format
 * list is the failure behaviour: an extractor that returns empty text on a
 * format it cannot read produces a document that is stored, indexed, and
 * silently unanswerable - which is exactly the "filed rather than kept" failure
 * one layer down.
 *
 * So extraction returns a reason when it fails, never an empty string, and the
 * caller records it. An unreadable document should be visible as unreadable.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ChunkKind } from "./chunk.js";

export type Extracted =
  | { ok: true; text: string; kind: ChunkKind; pages?: number }
  | { ok: false; reason: string };

/**
 * What kind of thing is this, for chunking purposes?
 *
 * Decided from the mime type first and the extension second, because a mime
 * type is what the sender claimed and an extension is what the file is called -
 * both are guesses, and the first one is usually the better guess.
 */
export function chunkKindFor(mime: string | null, filePath: string): ChunkKind {
  const ext = path.extname(filePath).toLowerCase();
  if (mime?.includes("csv") || [".csv", ".tsv"].includes(ext)) return "table";
  if ([".ts", ".js", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".sh", ".sql"].includes(ext)) {
    return "code";
  }
  if (mime?.startsWith("audio/") || ext === ".vtt" || ext === ".srt") return "transcript";
  if (ext === ".json" || ext === ".ndjson" || mime?.includes("json")) return "prose";
  return "prose";
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".ndjson", ".yaml", ".yml",
  ".html", ".htm", ".xml", ".log", ".ts", ".js", ".tsx", ".jsx", ".py", ".go",
  ".rs", ".java", ".rb", ".sh", ".sql", ".vtt", ".srt",
]);

function looksTextual(mime: string | null, filePath: string): boolean {
  if (mime?.startsWith("text/")) return true;
  if (mime?.includes("json") || mime?.includes("xml") || mime?.includes("csv")) return true;
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Strip the markup, keep the words.
 *
 * Not a parser and not trying to be: an HTML page indexed with its script tags
 * retrieves on the word "function". Scripts and styles go, tags become spaces,
 * and the entities that actually appear in prose are decoded.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractText(filePath: string, mime: string | null): Promise<Extracted> {
  const ext = path.extname(filePath).toLowerCase();

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { ok: false, reason: `no file at ${filePath}` };
  }
  /*
   * A ceiling, because this runs in the same process as everything else and a
   * 400 MB log would take the worker down with it. Refusing is honest; dying is
   * not.
   */
  if (stat.size > 32 * 1024 * 1024) {
    return { ok: false, reason: `too large to extract in-process (${Math.round(stat.size / 1e6)} MB)` };
  }

  if (ext === ".pdf" || mime === "application/pdf") {
    try {
      /*
       * Imported here rather than at module load: nothing else in the process
       * needs it, and a PDF library is not worth paying for on every boot.
       *
       * pdf-parse v2 is a class with getText(), not the v1 default-exported
       * function that most examples still show. Worth naming, because the v1
       * call typechecks against nothing and fails at run time.
       */
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: await fs.readFile(filePath) });
      const data = await parser.getText();
      await parser.destroy().catch(() => undefined);
      /*
       * The page markers are not content.
       *
       * pdf-parse v2 separates pages with lines like "-- 1 of 3 --". A scanned
       * PDF therefore extracts to a non-empty string containing only those
       * markers, which sails past an emptiness check and gets stored as a
       * successful ingest of a document that can never answer anything. Found
       * by the test that exists for exactly this failure.
       */
      const text = (data.text ?? "")
        .split("\n")
        .filter((l) => !/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/.test(l))
        .join("\n")
        .trim();
      if (!text) {
        /*
         * A scanned PDF is images of text. It extracts to nothing, and nothing
         * is indistinguishable from a document with nothing to say - so it is
         * reported rather than stored as an empty success.
         */
        return { ok: false, reason: "the PDF has no extractable text; it is probably scanned images" };
      }
      return { ok: true, text, kind: "prose", pages: data.pages?.length };
    } catch (err) {
      return { ok: false, reason: `could not read the PDF: ${err instanceof Error ? err.message : err}` };
    }
  }

  if (looksTextual(mime, filePath)) {
    const raw = await fs.readFile(filePath, "utf8").catch(() => null);
    if (raw === null) return { ok: false, reason: "the file is not valid UTF-8 text" };
    const text = ext === ".html" || ext === ".htm" || mime?.includes("html") ? htmlToText(raw) : raw;
    if (!text.trim()) return { ok: false, reason: "the file is empty" };
    return { ok: true, text, kind: chunkKindFor(mime, filePath) };
  }

  /*
   * Named rather than shrugged at. "unsupported" tells whoever asks why their
   * document cannot be searched, which is the difference between a gap and a
   * mystery.
   */
  return { ok: false, reason: `no extractor for ${mime ?? "unknown type"} (${ext || "no extension"})` };
}

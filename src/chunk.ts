/**
 * Splitting a document into the units retrieval will actually return (plan S30).
 *
 * The plan is blunt about why this file exists before any ranking code does:
 * *"retrieval quality is mostly a chunking problem, and uniform chunking is the
 * commonest cause of bad answers."* A fixed window is wrong in a different way
 * for every kind of content - it splits a function in half so it retrieves as
 * neither, it strips a spreadsheet row from the header that gives it meaning,
 * it cuts a speaker turn mid-sentence and loses who was talking.
 *
 * So the chunker branches on what it is reading. Each branch is a heuristic and
 * says so; none of them is clever, and the ones that guess wrong should guess
 * wrong in the direction of keeping too much context rather than too little.
 *
 * Two rules hold across every branch:
 *
 *  - **Never chunk across a document boundary.** Two documents joined in one
 *    chunk produce an answer that is true of neither, and it is invisible in
 *    testing because the text reads fluently. This is enforced by the signature:
 *    a call chunks one document, and there is no way to hand it two.
 *  - **Every chunk knows where it came from.** Not just which artifact, but
 *    where inside it, so a citation can say "page 4" rather than "somewhere in
 *    this PDF" - and so a wrong answer can be traced to the chunk that caused it.
 */

export type ChunkKind = "prose" | "chat" | "transcript" | "code" | "table" | "note";

export type Chunk = {
  body: string;
  /** Which chunk this is within its document, from 0. */
  index: number;
  /**
   * Where it starts in the source, as a character offset.
   *
   * Kept because a citation needs to point INTO the document, and because a bad
   * answer should be traceable to the text that produced it without re-reading
   * the whole file.
   */
  offset: number;
  /** A human-readable position: a heading, a speaker, a line range. */
  locator: string;
  kind: ChunkKind;
};

/**
 * Roughly a token, without a tokeniser.
 *
 * Four characters per token is the usual English approximation. It is used only
 * to decide when a group is "big enough", so being wrong by a third changes
 * chunk sizes slightly and changes nothing about correctness. A real tokeniser
 * here would be precision theatre.
 */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Below this, a document is left whole: a chunked three-line note is three worse notes. */
export const SHORT_DOCUMENT_TOKENS = 120;

/** What a group of small units is grown to before being emitted. */
const TARGET_TOKENS = 300;

/** How much of the previous chunk is repeated at the start of the next, for prose. */
const OVERLAP_CHARS = 200;

function chunk(body: string, index: number, offset: number, locator: string, kind: ChunkKind): Chunk {
  return { body: body.trim(), index, offset, locator, kind };
}

/**
 * Prose and PDFs: split on headings, because a heading is the unit the author
 * already chose. Sections that are still too long are split on paragraph
 * boundaries with overlap, so a sentence that answers a question is never
 * orphaned from the one before it.
 */
function chunkProse(text: string): Chunk[] {
  const lines = text.split("\n");
  const sections: { title: string; start: number; lines: string[] }[] = [];
  let current = { title: "", start: 0, lines: [] as string[] };
  let offset = 0;
  let sectionStart = 0;

  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line) || /^\s*\d+\.\s+\S.{0,60}$/.test(line)) {
      if (current.lines.length) sections.push({ ...current, start: sectionStart });
      current = { title: line.replace(/^#+\s*/, "").trim().slice(0, 80), start: offset, lines: [] };
      sectionStart = offset;
    }
    current.lines.push(line);
    offset += line.length + 1;
  }
  if (current.lines.length) sections.push({ ...current, start: sectionStart });

  const out: Chunk[] = [];
  for (const s of sections) {
    const body = s.lines.join("\n").trim();
    if (!body) continue;
    const title = s.title || "(untitled section)";
    if (approxTokens(body) <= TARGET_TOKENS * 2) {
      out.push(chunk(body, out.length, s.start, title, "prose"));
      continue;
    }
    // Too long even as a section: split on blank lines, carrying overlap.
    const paras = body.split(/\n\s*\n/);
    let buf = "";
    let bufOffset = s.start;
    for (const p of paras) {
      if (buf && approxTokens(buf + p) > TARGET_TOKENS) {
        out.push(chunk(buf, out.length, bufOffset, title, "prose"));
        const tail = buf.slice(-OVERLAP_CHARS);
        bufOffset += Math.max(0, buf.length - tail.length);
        buf = `${tail}\n\n${p}`;
      } else {
        buf = buf ? `${buf}\n\n${p}` : p;
      }
    }
    if (buf.trim()) out.push(chunk(buf, out.length, bufOffset, title, "prose"));
  }
  return out;
}

/**
 * Chat: one message plus the two around it.
 *
 * One message is rarely answerable alone - "yes, do that" means nothing without
 * what it answered. The window overlaps heavily on purpose: the same message
 * appears in three chunks, which costs storage and buys the answer its context.
 */
function chunkChat(text: string): Chunk[] {
  const messages = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!messages.length) return [];

  const out: Chunk[] = [];
  let offset = 0;
  const offsets = messages.map((m) => {
    const at = text.indexOf(m, offset);
    offset = at + m.length;
    return at < 0 ? 0 : at;
  });

  for (let i = 0; i < messages.length; i += 1) {
    const from = Math.max(0, i - 1);
    const to = Math.min(messages.length - 1, i + 1);
    const body = messages.slice(from, to + 1).join("\n");
    const speaker = /^([^:]{1,40}):/.exec(messages[i])?.[1] ?? "message";
    out.push(chunk(body, out.length, offsets[from], `${speaker}, message ${i + 1}`, "chat"));
  }
  return out;
}

/**
 * Transcripts: whole speaker turns, grouped until they are worth retrieving.
 *
 * A turn split mid-sentence loses who said it, which is usually the most
 * important thing in a transcript. Grouping stops at a turn boundary, never
 * inside one.
 */
function chunkTranscript(text: string): Chunk[] {
  const turnPattern = /^([A-Za-z][\w .'-]{0,40}):\s/;
  const lines = text.split("\n");
  const turns: { speaker: string; body: string; offset: number }[] = [];
  let offset = 0;
  for (const line of lines) {
    const m = turnPattern.exec(line);
    if (m || !turns.length) {
      turns.push({ speaker: m?.[1] ?? "unknown", body: line, offset });
    } else {
      turns[turns.length - 1].body += `\n${line}`;
    }
    offset += line.length + 1;
  }

  const out: Chunk[] = [];
  let buf: typeof turns = [];
  const flush = () => {
    if (!buf.length) return;
    const body = buf.map((t) => t.body).join("\n").trim();
    if (body) {
      const speakers = [...new Set(buf.map((t) => t.speaker))].join(", ");
      out.push(chunk(body, out.length, buf[0].offset, speakers, "transcript"));
    }
    buf = [];
  };
  for (const t of turns) {
    buf.push(t);
    if (approxTokens(buf.map((x) => x.body).join("\n")) >= TARGET_TOKENS) flush();
  }
  flush();
  return out;
}

/**
 * Source code: by symbol, because a function split in half retrieves as neither.
 *
 * Detected by indentation returning to column zero at a line that looks like a
 * declaration. This is a heuristic and will be wrong on some languages; it is
 * wrong in the safe direction, producing a larger chunk rather than a split one.
 */
function chunkCode(text: string): Chunk[] {
  const declaration = /^(export\s+)?(async\s+)?(function|class|const|let|var|def|type|interface|enum|impl|fn|public|private|protected)\b/;
  const lines = text.split("\n");
  const out: Chunk[] = [];
  let buf: string[] = [];
  let bufOffset = 0;
  let offset = 0;
  let currentName = "(top of file)";

  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) out.push(chunk(body, out.length, bufOffset, currentName, "code"));
    buf = [];
  };

  for (const line of lines) {
    if (declaration.test(line) && buf.length) {
      flush();
      bufOffset = offset;
      currentName = line.trim().slice(0, 80);
    } else if (declaration.test(line)) {
      bufOffset = offset;
      currentName = line.trim().slice(0, 80);
    }
    buf.push(line);
    offset += line.length + 1;
  }
  flush();
  return out;
}

/**
 * Tables: the header row goes on every chunk.
 *
 * Rows without their header mean nothing - "4820 | 12 | pending" is not an
 * answer to anything. Repeating the header is the cheapest way to make each
 * chunk independently readable.
 */
function chunkTable(text: string): Chunk[] {
  const rows = text.split("\n").filter((r) => r.trim());
  if (rows.length <= 1) return rows.length ? [chunk(rows[0], 0, 0, "row 1", "table")] : [];
  const header = rows[0];
  const out: Chunk[] = [];
  const WINDOW = 20;
  let offset = text.indexOf(rows[1]);
  for (let i = 1; i < rows.length; i += WINDOW) {
    const window = rows.slice(i, i + WINDOW);
    const body = [header, ...window].join("\n");
    out.push(chunk(body, out.length, Math.max(0, offset), `rows ${i + 1}-${i + window.length}`, "table"));
    offset += window.join("\n").length + 1;
  }
  return out;
}

/**
 * Split one document. One document, and never more than one.
 *
 * A short document comes back whole whatever its kind: three lines split three
 * ways are three worse notes, each too small to rank and none of them complete.
 */
export function chunkDocument(args: { text: string; kind: ChunkKind }): Chunk[] {
  const text = args.text.replace(/\r\n/g, "\n");
  if (!text.trim()) return [];

  if (args.kind === "note" || approxTokens(text) <= SHORT_DOCUMENT_TOKENS) {
    return [chunk(text, 0, 0, "whole document", args.kind)];
  }

  switch (args.kind) {
    case "chat": return chunkChat(text);
    case "transcript": return chunkTranscript(text);
    case "code": return chunkCode(text);
    case "table": return chunkTable(text);
    default: return chunkProse(text);
  }
}

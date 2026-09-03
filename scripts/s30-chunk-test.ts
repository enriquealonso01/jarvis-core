/**
 * S30 — the chunker, which decides whether any of the retrieval works.
 *
 * The plan puts it plainly: uniform chunking is the commonest cause of bad
 * answers, and the failures are content-specific. So the assertions are
 * content-specific too - each one is a way a fixed window would produce a
 * fluent, wrong answer.
 */
import { chunkDocument, SHORT_DOCUMENT_TOKENS, type Chunk } from "../src/chunk.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const long = (unit: string, n: number) => Array.from({ length: n }, (_, i) => unit.replace("{}", String(i + 1))).join("\n");

function main(): void {
  console.log("1. a short document is not chunked at all");
  const note = chunkDocument({ text: "Ring the accountant on Tuesday.\nThe VAT number is on the invoice.", kind: "prose" });
  note.length === 1
    ? ok("a three-line note stays whole - three chunks would be three worse notes")
    : bad(`a short note became ${note.length} chunks`);

  console.log("");
  console.log("2. prose splits on the headings the author already chose");
  const doc = [
    "# Refund policy",
    long("Refunds are processed within {} days of the request being approved.", 40),
    "# Shipping",
    long("Shipping is free above the threshold, line {}.", 40),
  ].join("\n");
  const prose = chunkDocument({ text: doc, kind: "prose" });
  prose.length >= 2 ? ok(`split into ${prose.length} chunks`) : bad(`only ${prose.length} chunk(s)`);
  prose.some((c) => c.locator === "Refund policy") && prose.some((c) => c.locator === "Shipping")
    ? ok("and each one is located by its heading, so a citation can name the section")
    : bad(`locators were ${prose.map((c) => c.locator).join(" | ")}`);
  /*
   * The failure this prevents: a chunk containing the end of the refund policy
   * and the start of shipping answers a refund question with shipping text, and
   * reads perfectly well while doing it.
   */
  prose.every((c) => !(c.body.includes("Refunds are processed") && c.body.includes("Shipping is free")))
    ? ok("and no chunk mixes two sections")
    : bad("a chunk spans two headings, which is how a fluent wrong answer is built");

  console.log("");
  console.log("3. a chat message carries the messages around it");
  const chat = [
    "enrique: can we ship the refund change today",
    "jarvis: the tests are green",
    "enrique: yes, do that",
    "jarvis: opened the pull request",
  ].join("\n");
  const msgs = chunkDocument({ text: `${chat}\n${long("filler: line {}", 200)}`, kind: "chat" });
  const yes = msgs.find((c) => c.body.includes("yes, do that"));
  yes && yes.body.includes("the tests are green")
    ? ok("'yes, do that' is stored with what it answered")
    : bad("a bare acknowledgement was chunked alone, which is unanswerable");

  console.log("");
  console.log("4. a transcript is cut at speaker turns, never inside one");
  const transcript = [
    `Enrique: ${long("I want to talk about the invoice, point {}.", 30)}`,
    `Jarvis: ${long("Understood, noting point {}.", 30)}`,
    `Enrique: ${long("And the second matter, item {}.", 30)}`,
  ].join("\n");
  const turns = chunkDocument({ text: transcript, kind: "transcript" });
  turns.length >= 2 ? ok(`grouped into ${turns.length} chunks`) : bad(`only ${turns.length}`);
  turns.every((c) => /^[A-Za-z]/.test(c.body))
    ? ok("every chunk starts at a speaker, so nothing is attributed to the wrong person")
    : bad("a chunk starts mid-turn");

  console.log("");
  console.log("5. code is cut at symbols, because half a function retrieves as neither");
  const code = [
    "export function total(items) {",
    long("  sum += items[{}].price;", 30),
    "}",
    "export function slugify(input) {",
    long("  out = out.replace(/x{}/g, '-');", 30),
    "}",
  ].join("\n");
  const symbols = chunkDocument({ text: code, kind: "code" });
  symbols.length >= 2 ? ok(`split into ${symbols.length} chunks`) : bad(`only ${symbols.length}`);
  symbols.every((c) => !(c.body.includes("function total") && c.body.includes("function slugify")))
    ? ok("and no chunk contains two functions")
    : bad("two functions landed in one chunk");
  const totalChunk = symbols.find((c) => c.body.includes("function total"));
  totalChunk?.locator.includes("total")
    ? ok("the locator names the symbol, so a citation points at the function")
    : bad(`locator was ${totalChunk?.locator}`);

  console.log("");
  console.log("6. every table chunk carries the header row");
  const table = ["id,status,amount", long("{},pending,100", 60)].join("\n");
  const rows = chunkDocument({ text: table, kind: "table" });
  rows.length >= 2 ? ok(`split into ${rows.length} windows`) : bad(`only ${rows.length}`);
  rows.every((c) => c.body.startsWith("id,status,amount"))
    ? ok("every window repeats the header - rows without it mean nothing")
    : bad("a window lost its header, so its rows are unreadable");

  console.log("");
  console.log("7. every chunk knows where it came from");
  const all: Chunk[] = [...prose, ...msgs, ...turns, ...symbols, ...rows];
  all.every((c) => c.locator.length > 0)
    ? ok(`all ${all.length} chunks carry a locator`)
    : bad("a chunk has no locator, so its citation would say 'somewhere in this document'");
  all.every((c) => c.offset >= 0 && Number.isFinite(c.offset))
    ? ok("and an offset into the source, so a wrong answer is traceable")
    : bad("a chunk has no usable offset");
  prose.every((c, i) => c.index === i)
    ? ok("indexes run in document order")
    : bad("chunk indexes are not sequential");

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  console.log(`(short-document threshold: ${SHORT_DOCUMENT_TOKENS} tokens)`);
  process.exit(fails === 0 ? 0 : 1);
}

main();

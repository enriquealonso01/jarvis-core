/**
 * The build bar's state comes from ONE file, and says which encoding it is in.
 *
 * Two defects are being held closed here, both of which shipped and both of
 * which looked fine from the outside:
 *
 *  1. The bar read a COPY under the console's static root, published by a
 *     script run by hand. It went 21 hours stale — S5 / 37 steps against a repo
 *     on S25 / 40 — and a console deploy's `rsync --delete` removed it outright.
 *     So the test is not "the endpoint returns JSON"; it is "the endpoint
 *     returns THIS repo's PROGRESS.json", compared field by field against the
 *     file on disk. A stale copy passes the first and fails the second.
 *
 *  2. Caddy served that copy as `application/json` with no charset, under
 *     `X-Content-Type-Options: nosniff`. A browser with nothing to sniff and no
 *     charset to obey fell back to its locale default and drew every em-dash as
 *     `â€"`. The bytes were UTF-8 the whole time. So the charset is asserted on
 *     the header, and the round trip is asserted on a character that only
 *     survives it.
 */
import fs from "node:fs";

const BASE = process.env.JARVIS_API ?? "http://127.0.0.1:8080";
const PROGRESS = new URL("../PROGRESS.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m, e, a) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 200)}`);
  fail += 1;
};
const check = (m, e, a) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m, a) => (a ? ok(m) : bad(m, "truthy", a));

async function main() {
  console.log("########## one source: the endpoint serves the repo's own file ##########\n");

  const onDisk = JSON.parse(fs.readFileSync(PROGRESS, "utf8"));
  const res = await fetch(`${BASE}/PROGRESS.json`);
  check("it answers 200", 200, res.status);

  const ctype = res.headers.get("content-type") ?? "";
  truthy(`and declares UTF-8 (${ctype})`, /charset=utf-8/i.test(ctype));
  truthy("with a Last-Modified, so staleness is visible at all", res.headers.get("last-modified"));

  const raw = await res.text();
  const served = JSON.parse(raw);

  /*
   * The three fields the bar actually draws from. Compared against the file
   * rather than against a constant, so this test cannot itself go stale.
   */
  check("the same current step as the file", onDisk.current_step, served.current_step);
  check("the same updated_at", onDisk.updated_at, served.updated_at);
  check("the same number of steps", onDisk.steps.length, served.steps.length);
  check("the same plan sha", onDisk.plan_sha, served.plan_sha);

  console.log("\n########## the encoding survives the round trip ##########\n");
  {
    /*
     * Find a real em-dash in the file and prove the same character comes back.
     * `fetch` decodes by the declared charset, so this assertion is exactly the
     * browser's experience — it goes red if the charset is dropped.
     */
    const withDash = JSON.stringify(onDisk).includes("—");
    truthy("the file contains an em-dash to test with", withDash);
    truthy("and it comes back as one, not as \\u00e2\\u20ac\\u201d", raw.includes("—"));
    check("no mojibake anywhere in the body", false, raw.includes("â€"));
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n==== ${pass} passed, ${fail + 1} failed ====`);
  process.exit(1);
});

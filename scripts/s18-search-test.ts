/**
 * S18 — one search box, and the boundary it must never cross. (plan S18)
 *
 * The Done when has three clauses and the third is not a UX property:
 *
 *   "a phrase inside a document dumped three months ago is findable in one
 *    search, every palette command works on desktop and mobile, and SEARCH
 *    CANNOT CROSS A PROJECT BOUNDARY."
 *
 * The plan says of the last one: "This is an isolation test, not a UX test, and
 * it stops other work if it fails." So it is tested the way S12's probes are —
 * by putting a distinctive string in project B and asking project A for it, from
 * every source search can read, and failing loudly on any leak.
 *
 * The palette half is a browser test; this is everything the API owes it.
 */
import { deleteProjects } from "./_teardown.js";
import { createPool } from "../src/db.js";

const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 300)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));

const API = process.env.S18_API ?? "http://api:8080";
const ORIGIN = process.env.JARVIS_ORIGIN ?? "http://localhost:8080";
let cookie = "";

async function login(): Promise<void> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({
      email: process.env.JARVIS_OPERATOR_EMAIL ?? "dev@jarvis.local",
      password: process.env.JARVIS_OPERATOR_PASSWORD ?? "dev-password-1234",
    }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error(`could not log in: ${res.status}`);
}

async function get(p: string): Promise<any> {
  const res = await fetch(`${API}${p}`, { headers: { Cookie: cookie, Origin: ORIGIN } });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const STAMP = Date.now().toString(36);
/** A word that exists nowhere else in the database. */
const SECRET_B = `zarquon${STAMP}`;
const SHARED = `quibble${STAMP}`;

async function project(slug: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality,production_status)
     VALUES ($1,$1,'personal','normal','non_production')
     ON CONFLICT (slug) DO UPDATE SET archived_at = NULL RETURNING id`,
    [slug],
  );
  return r.rows[0].id;
}

async function main(): Promise<void> {
  await login();
  const alpha = await project(`s18-alpha-${STAMP}`);
  const beta = await project(`s18-beta-${STAMP}`);

  /*
   * The same distinctive word in EVERY source, but on project B. Every one of
   * these is a place search reads from, and any one of them leaking is the
   * failure the plan says stops other work.
   */
  const convB = (await pool.query<{ id: string }>(
    `INSERT INTO conversations (project_id, title, channel)
     VALUES ($1, $2, 'web') RETURNING id`,
    [beta, `beta thread ${SECRET_B}`],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO messages (conversation_id, role, body) VALUES ($1,'user',$2)`,
    [convB, `something about ${SECRET_B} in a message`],
  );
  await pool.query(
    `INSERT INTO tasks (project_id,title,objective,state,lane,priority)
     VALUES ($1,$2,$3,'queued','heavy','normal')`,
    [beta, `beta task ${SECRET_B}`, `objective mentioning ${SECRET_B}`],
  );
  await pool.query(
    `INSERT INTO issues (severity,category,service,status,owner,title,dedupe_key,project_id,required_action)
     VALUES ('low','test','test','open','jarvis',$1,$2,$3,$4)`,
    [`beta issue ${SECRET_B}`, `s18.${STAMP}`, beta, `do something about ${SECRET_B}`],
  );
  await pool.query(
    `INSERT INTO artifacts (project_id, path, mime, bytes, source, quarantine_state, retention_class)
     VALUES ($1, $2, 'text/plain', 4, 'test', 'clean', 'other')`,
    [beta, `s18/${SECRET_B}.txt`],
  );
  await pool.query(
    `INSERT INTO knowledge_chunks (project_id, body) VALUES ($1, $2)`,
    [beta, `page 14 of the dumped report says ${SECRET_B} plainly`],
  );
  await pool.query(
    `INSERT INTO memory_items (project_id, kind, body) VALUES ($1, 'fact', $2)`,
    [beta, `remember that ${SECRET_B} matters`],
  );
  await pool.query(
    `INSERT INTO inbox_events (channel, sender, raw_text, checksum, capture_state, processing_state, project_id)
     VALUES ('web','enrique',$1,$2,'persisted','processed',$3)`,
    [`a voice note about ${SECRET_B}`, `s18-${STAMP}`, beta],
  );

  // Something on A too, so a scoped search has a positive to find.
  await pool.query(
    `INSERT INTO tasks (project_id,title,objective,state,lane,priority)
     VALUES ($1,$2,$3,'queued','heavy','normal')`,
    [alpha, `alpha task ${SHARED}`, `alpha objective ${SHARED}`],
  );
  await pool.query(
    `INSERT INTO knowledge_chunks (project_id, body) VALUES ($1, $2)`,
    [alpha, `the alpha document mentions ${SHARED} on page two`],
  );

  // ------------------------------------------------------- one search, many kinds
  console.log("=== one box, everything in it ===");
  const all = await get(`/api/search?q=${SECRET_B}`);
  check("search answers", 200, all.status);
  const kinds = (all.json.groups as { kind: string }[]).map((g) => g.kind).sort();
  console.log(`  found in: ${kinds.join(", ")}`);
  for (const kind of ["conversation", "message", "task", "issue", "artifact", "document", "memory", "inbox"]) {
    truthy(`  ${kind} is searched`, kinds.includes(kind));
  }
  truthy("results are grouped by kind, not one flat list", Array.isArray(all.json.groups));
  {
    const g = (all.json.groups as { kind: string; hits: { snippet: string | null }[] }[])
      .find((x) => x.kind === "message");
    truthy("and a hit shows why it is a hit", g?.hits[0]?.snippet?.includes(SECRET_B));
  }

  // ------------------------------------ a phrase inside a dumped document
  console.log("\n=== a phrase inside a document ===");
  {
    const r = await get(`/api/search?q=${encodeURIComponent("page 14 of the dumped report")}`);
    const g = (r.json.groups as { kind: string; hits: { title: string }[] }[])
      .find((x) => x.kind === "document");
    truthy("a phrase that exists only inside a document is found", g && g.hits.length > 0);
    truthy(
      "and the result points at the document it came from",
      g?.hits[0]?.title !== undefined,
    );
  }

  // ---------------------------------------------------------- zero results
  console.log("\n=== nothing matches ===");
  {
    const r = await get("/api/search?q=vogonpoetry-nothing-matches-this");
    check("it answers rather than erroring", 200, r.status);
    check("with no groups", 0, r.json.groups.length);
    truthy("and says so, rather than rendering an empty list", r.json.note?.includes("Nothing matches"));
  }

  // ================================================== THE ISOLATION CLAUSE
  console.log("\n########## search cannot cross a project boundary ##########\n");
  const scoped = await get(`/api/search?q=${SECRET_B}&project_id=${alpha}`);
  check("a scoped search answers", 200, scoped.status);
  const leaks: string[] = [];
  for (const g of (scoped.json.groups ?? []) as { kind: string; hits: { title: string; snippet: string | null }[] }[]) {
    for (const h of g.hits) {
      if (`${h.title} ${h.snippet ?? ""}`.includes(SECRET_B)) leaks.push(`${g.kind}: ${h.title}`);
    }
  }
  check("project B's content does not appear in a search scoped to A", "", leaks.join(" | "));
  check("in fact nothing at all comes back", 0, scoped.json.total);

  {
    // ...and the scope is not simply refusing everything.
    const positive = await get(`/api/search?q=${SHARED}&project_id=${alpha}`);
    truthy("while A's own content IS found when scoped to A", positive.json.total > 0);
    const alphaKinds = (positive.json.groups as { kind: string }[]).map((g) => g.kind);
    truthy("including inside A's documents", alphaKinds.includes("document"));
    const other = await get(`/api/search?q=${SHARED}&project_id=${beta}`);
    check("and the same word scoped to B finds nothing", 0, other.json.total);
  }

  // --------------------------------------------------------- activity feed
  console.log("\n=== the activity feed ===");
  {
    // Provoked, not inserted: creating a task is what writes the feed line.
    const { createTask } = await import("../src/work.js");
    const id = await createTask(pool, {
      projectId: alpha,
      conversationId: null,
      originInboxId: null,
      title: `S18 feed check ${STAMP}`,
      objective: "x",
      lane: "heavy",
      priority: "normal",
      cause: "s18 test",
    });
    const feed = await get(`/api/activity?project_id=${alpha}`);
    check("the feed answers", 200, feed.status);
    truthy(
      "and creating a task put a line in it",
      (feed.json.events as { subject_id: string }[]).some((e) => e.subject_id === id),
    );
    const betaFeed = await get(`/api/activity?project_id=${beta}`);
    check(
      "which is not in the other project's feed",
      0,
      (betaFeed.json.events as { subject_id: string }[]).filter((e) => e.subject_id === id).length,
    );
  }
  {
    const empty = await project(`s18-quiet-${STAMP}`);
    const feed = await get(`/api/activity?project_id=${empty}`);
    check("a project with no activity has an empty feed", 0, feed.json.events.length);
    truthy("that says so", feed.json.note?.includes("Nothing has happened here yet"));
  }
  {
    // Pagination, on a feed with more than a page in it.
    for (let i = 0; i < 60; i += 1) {
      await pool.query(
        `INSERT INTO activity_events (project_id, kind, title) VALUES ($1,'task',$2)`,
        [alpha, `bulk ${i} ${STAMP}`],
      );
    }
    const p1 = await get(`/api/activity?project_id=${alpha}&limit=25&offset=0`);
    const p2 = await get(`/api/activity?project_id=${alpha}&limit=25&offset=25`);
    check("the first page holds twenty-five", 25, p1.json.events.length);
    check("and the second another twenty-five", 25, p2.json.events.length);
    const ids = new Set((p1.json.events as { id: string }[]).map((e) => e.id));
    check(
      "with no overlap",
      0,
      (p2.json.events as { id: string }[]).filter((e) => ids.has(e.id)).length,
    );
    truthy("and the total is reported, not just the page", p1.json.total >= 60);
  }

  // ------------------------------------------------------- a slope, not a gauge
  console.log("\n=== disk over time, not disk right now ===");
  {
    await pool.query("DELETE FROM resource_metrics");
    const thin = await get("/api/metrics/trend?metric=disk");
    check("with no history it says so", null, thin.json.slope_per_day);
    truthy("in words", thin.json.note?.includes("not enough history"));

    /*
     * Backdated samples. The plan's own test is "let it run 24h" — which is
     * right for the sampler and useless for the ARITHMETIC, and the arithmetic
     * is what turns a column of numbers into "climbed nine points this week".
     * The sampler is a five-minute interval in the worker; this tests the slope.
     */
    for (let day = 7; day >= 0; day -= 1) {
      await pool.query(
        `INSERT INTO resource_metrics (at, disk_used_pct, memory_used_pct)
         VALUES (now() - make_interval(days => $1), $2, 50)`,
        [day, 75 + (7 - day) * 1.5],
      );
    }
    const trend = await get("/api/metrics/trend?metric=disk&hours=240");
    check("eight samples", 8, trend.json.samples);
    truthy("it can say which way disk is going", trend.json.slope_per_day > 1.4);
    check("and by how much over the window", 10.5, trend.json.change_over_window);
    ok(`  disk climbed ${trend.json.change_over_window} points in a week — the sentence the plan asks for`);
  }

  /*
   * Take the two projects back out, and everything that came to point at them.
   *
   * This suite left `s18-alpha-<stamp>` and `s18-beta-<stamp>` behind on every
   * run, and the consequence was not the litter itself. Stage B's rule 4 is the
   * correlation window - same channel, same sender, inside ten minutes - so once
   * one message correlated into a leftover s18 thread, every later message
   * joined it too, and the window never closed because the suites run
   * back-to-back. s37-untrusted-test failed against that attractor for three
   * assertions that were about something else entirely.
   *
   * The correlation window is correct product behaviour. What was wrong was
   * leaving a thread lying around for it to correlate into.
   */
  const removed = await deleteProjects(pool, [alpha, beta]);
  if ((removed.projects ?? 0) !== 2) {
    console.error("teardown: fixtures not fully removed:", JSON.stringify(removed));
    fail += 1;
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

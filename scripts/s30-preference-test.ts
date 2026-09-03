/**
 * S30 — preferences that change, and remarks that must not change them.
 *
 * Three of the four behaviours here are about the OLD statement: the current
 * one answers, Jarvis says so at the moment of the replacement, and the old one
 * stays visible in the audit. The fourth is restraint, and it is the hard one:
 * a passing remark that merely resembles a preference must not overwrite one.
 *
 * The costs are asymmetric, which is why the restraint matters more than the
 * learning. Failing to record a real preference is an annoyance he can fix by
 * repeating himself. Overwriting one with an offhand remark changes how the
 * system behaves without anybody deciding to change it, and he finds out later,
 * from the behaviour.
 */
import { createPool } from "../src/db.js";
import { removeFixtures } from "./lib/fixtures.js";
import { isForgetRequest, isStandingInstruction, recordStatement, sameSubject } from "../src/preference.js";
import { retrieve } from "../src/knowledge.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s30pref-${Math.random().toString(36).slice(2, 7)}`;

const created: string[] = [];

async function main(): Promise<void> {
  console.log("1. a standing instruction is recognised; a remark is not");
  isStandingInstruction("always write pull request titles in the imperative")
    ? ok("'always ...' is a standing instruction")
    : bad("an always-rule was not recognised");
  isStandingInstruction("from now on, squash the commits")
    ? ok("and so is 'from now on ...'")
    : bad("a from-now-on rule was not recognised");
  !isStandingInstruction("that pull request title was a bit long")
    ? ok("while an observation about a pull request title is not")
    : bad("a passing remark was treated as an instruction");
  !isStandingInstruction("the commits looked fine to me")
    ? ok("and neither is a compliment about commits")
    : bad("a compliment was treated as an instruction");
  isForgetRequest("forget what I told you about commit messages")
    ? ok("and a forget-request is recognised")
    : bad("a forget request was not recognised");

  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG]);
  const pid = p.rows[0].id;
  created.push(pid);

  console.log("");
  console.log("2. stating a preference, then contradicting it");
  const first = await recordStatement(pool, {
    projectId: pid, text: "always write pull request titles in the imperative mood",
  });
  first.action === "stored" ? ok("the first instruction is stored") : bad(`first returned ${first.action}`);

  const second = await recordStatement(pool, {
    projectId: pid, text: "from now on write pull request titles in the past tense, not the imperative",
  });
  second.action === "stored" && second.replaced.length === 1
    ? ok("the second replaces the first")
    : bad(`the second returned ${JSON.stringify(second).slice(0, 90)}`);
  /*
   * Said at the moment of replacement. A preference that changes silently is
   * one he cannot correct, because he never learns it changed.
   */
  second.action === "stored" && second.note.includes("replaces what you told me")
    ? ok(`and says so at that moment: "${second.action === "stored" ? second.note.slice(0, 60) : ""}"`)
    : bad("the replacement happened silently");

  console.log("");
  console.log("3. the current one answers; the old one is gone from retrieval, not from the record");
  const found = await retrieve(pool, { q: "pull request titles imperative past tense", projectId: pid });
  const mem = (found.tiers.find((t) => t.tier === "project_memory")?.hits ?? []).map((h) => h.body).join(" ");
  mem.includes("past tense")
    ? ok("the current instruction answers")
    : bad(`retrieval returned: ${mem.slice(0, 80)}`);
  !mem.includes("imperative mood")
    ? ok("and the replaced one does not")
    : bad("the withdrawn instruction is still being answered with");

  const audit = await pool.query<{ n: string; reason: string; by: string | null }>(
    `SELECT count(*) OVER () AS n, superseded_reason AS reason, superseded_by::text AS by
       FROM memory_items WHERE project_id = $1 AND superseded_at IS NOT NULL LIMIT 1`, [pid]);
  Number(audit.rows[0]?.n ?? 0) === 1
    ? ok("it is still in the record, superseded rather than deleted")
    : bad("the old instruction was destroyed, so the audit cannot show what changed");
  audit.rows[0]?.reason === "replaced" && audit.rows[0]?.by
    ? ok("labelled as replaced, and pointing at what replaced it")
    : bad(`the superseded row is unlabelled: ${JSON.stringify(audit.rows[0])}`);

  console.log("");
  console.log("4. a passing remark does not overwrite an instruction");
  const remark = await recordStatement(pool, {
    projectId: pid, text: "that last pull request title read a little oddly in the past tense",
  });
  remark.action === "noted"
    ? ok("the remark is kept as a note")
    : bad(`a remark returned ${remark.action}`);
  const stillThere = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM memory_items
      WHERE project_id = $1 AND kind = 'preference' AND superseded_at IS NULL`, [pid]);
  Number(stillThere.rows[0].n) === 1
    ? ok("and the standing instruction is untouched")
    : bad(`the remark changed the live preferences (${stillThere.rows[0].n} live)`);

  console.log("");
  console.log("5. forget what I told you about that");
  const forget = await recordStatement(pool, {
    projectId: pid, text: "forget what I told you about pull request titles",
  });
  forget.action === "forgotten" && forget.forgot.length >= 1
    ? ok(`${forget.action === "forgotten" ? forget.forgot.length : 0} statement(s) withdrawn`)
    : bad(`forget returned ${JSON.stringify(forget).slice(0, 80)}`);
  const after = await retrieve(pool, { q: "pull request titles past tense", projectId: pid });
  ((after.tiers.find((t) => t.tier === "project_memory")?.hits ?? []).length) === 0
    ? ok("it is not retrieved afterwards")
    : bad("a withdrawn instruction is still being answered with");
  const kept = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM memory_items
      WHERE project_id = $1 AND superseded_reason = 'forgotten'`, [pid]);
  Number(kept.rows[0].n) >= 1
    ? ok("and it is still present as a withdrawn record")
    : bad("the withdrawn statement was deleted, so nothing can show it was ever said");

  console.log("");
  console.log("6. subject matching is about overlap, not about agreement");
  sameSubject("always squash the commits", "from now on do not squash the commits")
    ? ok("two opposite statements about commits are the same subject")
    : bad("opposite statements about one subject were treated as unrelated");
  !sameSubject("always squash the commits", "the staging database needs restoring")
    ? ok("while unrelated statements are not")
    : bad("unrelated statements were treated as the same subject");

  console.log("");
  console.log("7. the same rule applies through the router, not only when called directly");
  /*
   * The gap this closes: recordStatement existed and nothing called it. The
   * capture path inserted a plain note, so a standing instruction never
   * replaced the one it contradicted - both sat in the store with nothing to
   * say which was current. A rule that only holds when a test calls the
   * function directly is not a rule the system has.
   */
  const { applyRoute } = await import("../src/routing.js");
  const conv = await pool.query<{ id: string }>(
    `INSERT INTO conversations (project_id, channel) VALUES ($1,'whatsapp') RETURNING id`, [pid]);

  const capture = async (text: string) => {
    const inbox = await pool.query<{ id: string }>(
      `INSERT INTO inbox_events (channel, sender, raw_text, checksum, capture_state, processing_state, project_id)
       VALUES ('whatsapp','enrique',$1,$2,'persisted','pending',$3) RETURNING id`,
      [text, `pref-${Math.random()}`, pid]);
    return applyRoute(pool, {
      inboxId: inbox.rows[0].id,
      sourceConversationId: conv.rows[0].id,
      sourceProjectId: pid,
      decision: {
        available: true,
        segments: [{ category: "capture", project: null, text }],
      } as never,
    });
  };

  await capture("always squash commits before merging");
  const viaRouter = await pool.query<{ kind: string }>(
    `SELECT kind FROM memory_items WHERE project_id = $1 AND body LIKE 'always squash%'`, [pid]);
  viaRouter.rows[0]?.kind === "preference"
    ? ok("a standing instruction routed through the router is stored as a preference")
    : bad(`the router stored it as ${viaRouter.rows[0]?.kind ?? "nothing"}`);

  const routed = await capture("from now on do not squash commits before merging");
  const superseded = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM memory_items
      WHERE project_id = $1 AND body LIKE 'always squash%' AND superseded_at IS NOT NULL`, [pid]);
  Number(superseded.rows[0].n) === 1
    ? ok("and contradicting it through the router supersedes the first")
    : bad("the router left two contradicting instructions both live");
  JSON.stringify(routed).includes("replaces what you told me")
    ? ok("with the replacement said back, through the real path")
    : bad("the router replaced a preference silently");

  // Memories first: they point at the inbox events that produced them.
  await pool.query(`DELETE FROM memory_items WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM conversations WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM inbox_events WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [pid]);

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

/*
 * Cleanup in a `finally`, not at the bottom of main.
 *
 * The runs that leave litter are the ones that failed, and those are exactly
 * the runs that never reach a tidy-up written at the end of the happy path.
 */
main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    fails += 1;
  })
  .finally(async () => {
    await removeFixtures(pool, created);
    await pool.end().catch(() => undefined);
    process.exit(fails === 0 ? 0 : 1);
  });

/**
 * A fixture cleans up after itself, including out of Enrique's queue.
 *
 * Three of the five Issues waiting on him were review reports about throwaway
 * repositories created by suites that never tore anything down. The tickets
 * looked exactly like real requests: a title, a required action, and a project
 * that no longer meant anything.
 */
import { createPool } from "../src/db.js";
import { teardownFixtureProject } from "./lib/fixture.js";

const pool = createPool();
let fails = 0;
const ok = (m: string) => console.log(`  ok   - ${m}`);
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails++; };

async function waitingCount(): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM issues WHERE status = 'waiting_for_user'`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function main() {
  const slug = `teardown-${Date.now()}`;
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, project_type) VALUES ($1, $1, 'personal') RETURNING id`,
    [slug],
  );
  const pid = p.rows[0].id;

  // The shape a parity run leaves behind: a task with history, and a ticket.
  const t = await pool.query<{ id: string }>(
    `INSERT INTO tasks (project_id, lane, title, objective, state)
     VALUES ($1, 'heavy', 'fix the trailing dash', 'seeded bug', 'succeeded') RETURNING id`,
    [pid],
  );
  await pool.query(
    `INSERT INTO task_transitions (task_id, from_state, to_state, cause, actor)
     VALUES ($1, 'queued', 'running', 'test', 'runner')`, [t.rows[0].id],
  );
  await pool.query(
    `INSERT INTO issues (severity, category, project_id, service, status, owner, title, required_action, dedupe_key)
     VALUES ('high', 'workflow.report', $1, 'runner', 'waiting_for_user', 'user',
             '[review] fix the trailing dash (codex)', 'Read what it reported.', $2)`,
    [pid, `workflow.report:${slug}`],
  );
  await pool.query(
    `INSERT INTO auth_profile_allowlists (auth_profile_id, project_id, allowed_roles)
     VALUES ('anthropic_personal', $1, ARRAY['senior_engineer']) ON CONFLICT DO NOTHING`, [pid],
  );

  const before = await waitingCount();
  console.log(`1. the fixture leaves a ticket in the queue (${before} waiting)`);
  before > 0 ? ok("queue has the fixture ticket") : bad("no ticket to clean up - fixture not set up");

  console.log("2. teardown removes it, and everything else pointing at the project");
  const result = await teardownFixtureProject(pool, pid);
  const after = await waitingCount();
  after === before - 1
    ? ok(`queue back to ${after}`)
    : bad(`queue is ${after}, expected ${before - 1}`);
  (result.removed.issues ?? 0) === 1 ? ok("the ticket was removed") : bad(`removed.issues=${result.removed.issues}`);
  (result.removed.tasks ?? 0) === 1 ? ok("the task went too") : bad(`removed.tasks=${result.removed.tasks}`);
  (result.removed.projects ?? 0) === 1 ? ok("and the project") : bad("the project survived");

  console.log("3. nothing anywhere still references the project");
  result.leftBehind.length === 0
    ? ok("no dangling rows")
    : bad(`left behind: ${result.leftBehind.map((l) => `${l.table}(${l.rows})`).join(", ")}`);

  console.log("4. the leftover check can actually see a leftover");
  // Otherwise assertion 3 is a green light that proves nothing: it would pass
  // just as happily if the check were blind.
  const p2 = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug, name, project_type) VALUES ($1, $1, 'personal') RETURNING id`,
    [`${slug}-b`],
  );
  const pid2 = p2.rows[0].id;
  await pool.query(
    `INSERT INTO issues (severity, category, project_id, service, status, owner, title, dedupe_key)
     VALUES ('low', 'workflow.report', $1, 'runner', 'open', 'jarvis', 'left behind on purpose', $2)`,
    [pid2, `left-behind:${slug}`],
  );
  const seen = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM issues WHERE project_id = $1`, [pid2],
  );
  Number(seen.rows[0].n) === 1 ? ok("a dangling row exists to be found") : bad("setup failed");
  const second = await teardownFixtureProject(pool, pid2);
  second.leftBehind.length === 0 && (second.removed.issues ?? 0) === 1
    ? ok("and the teardown removed it rather than reporting it clean")
    : bad(`leftBehind=${JSON.stringify(second.leftBehind)}`);

  await pool.end();
  console.log(fails === 0 ? "\nFixture teardown PASS" : `\nFixture teardown FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

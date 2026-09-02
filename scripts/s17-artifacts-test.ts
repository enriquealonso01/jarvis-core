/**
 * S17 — an output you can review, reject, revise and compare. (plan S17)
 *
 * The Done when is one sentence and it is a sequence: "an output can be
 * reviewed, rejected with a note that becomes a task, revised, and the two
 * versions compared — without leaving the console."
 *
 * So the shape of this suite is that sequence, run end to end, with the two
 * things that make it more than a status field asserted hardest:
 *
 *   - a rejection is a WORK INSTRUCTION. The note has to arrive in a real task,
 *     against the same project, or Enrique has to restate it and the loop is
 *     not closed.
 *   - a second attempt SUPERSEDES rather than overwrites. The plan: "an
 *     artifact overwritten in place rather than superseded has already
 *     destroyed the evidence and no amount of UI work will bring it back."
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createPool } from "../src/db.js";
import { ARTIFACTS_DIR } from "../src/paths.js";
import { ARTIFACT_TYPES, canTransition, lineage, recordArtifact } from "../src/artifacts.js";

const pool = createPool();
let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  PASS  ${m}`); pass += 1; };
const bad = (m: string, e: unknown, a: unknown) => {
  console.log(`  FAIL  ${m}`);
  console.log(`        expected: ${String(e)}`);
  console.log(`        actual:   ${String(a).slice(0, 240)}`);
  fail += 1;
};
const check = (m: string, e: unknown, a: unknown) => (e === a ? ok(m) : bad(m, e, a));
const truthy = (m: string, a: unknown) => (a ? ok(m) : bad(m, "truthy", a));

const API = process.env.S17_API ?? "http://api:8080";
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

async function req(
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      Cookie: cookie,
      Origin: ORIGIN,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

/** Put a real file on disk so previews and downloads have something to read. */
async function write(rel: string, content: string): Promise<number> {
  const full = path.join(ARTIFACTS_DIR, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return Buffer.byteLength(content);
}

async function main(): Promise<void> {
  await login();
  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality,production_status)
     VALUES ('s17-outputs','s17-outputs','personal','normal','non_production')
     ON CONFLICT (slug) DO UPDATE SET archived_at = NULL RETURNING id`,
  );
  const projectId = project.rows[0].id;
  await pool.query("DELETE FROM artifacts WHERE path LIKE 's17/%'");

  // ------------------------------------------------------ every type renders
  console.log("=== every type of output has a page that says what it is ===");
  const made: Record<string, string> = {};
  for (const type of ARTIFACT_TYPES) {
    const isLink = type === "pull_request" || type === "deployment_url";
    const rel = `s17/${type}.txt`;
    const bytes = isLink ? 0 : await write(rel, `a ${type}\nline two\n`);
    const r = await recordArtifact(pool, {
      projectId,
      path: isLink ? `https://example.invalid/${type}` : rel,
      type,
      mime: isLink ? null : "text/plain",
      bytes,
      externalUrl: isLink ? `https://example.invalid/${type}` : null,
      agent: "s17",
      model: "fake",
      harness: "fake",
      authProfile: "anthropic_personal",
    });
    made[type] = r.id;
  }
  let unrendered: string[] = [];
  for (const [type, id] of Object.entries(made)) {
    const d = await req("GET", `/api/artifacts/${id}/detail`);
    if (d.status !== 200 || !d.json?.preview_kind || d.json.preview_kind === "") {
      unrendered.push(`${type}:${d.status}`);
    }
  }
  check(`all ${ARTIFACT_TYPES.length} types render`, "", unrendered.join(" | "));
  {
    const pr = await req("GET", `/api/artifacts/${made.pull_request}/detail`);
    check("a pull request previews as a link, not a file", "link", pr.json.preview_kind);
    const doc = await req("GET", `/api/artifacts/${made.document}/detail`);
    check("a text document previews as text", "text", doc.json.preview_kind);
    truthy("with its content", String(doc.json.preview ?? "").includes("a document"));
  }
  {
    // The plan: say "no preview available" rather than rendering nothing.
    const bin = await recordArtifact(pool, {
      projectId, path: "s17/blob.bin", type: "dataset", mime: "application/octet-stream",
      bytes: 10, agent: "s17",
    });
    const d = await req("GET", `/api/artifacts/${bin.id}/detail`);
    check("a type with no renderer says so rather than showing nothing", "none", d.json.preview_kind);
  }

  // ---------------------------------------------------- provenance is present
  console.log("\n=== provenance, recorded at registration ===");
  {
    const d = await req("GET", `/api/artifacts/${made.report}/detail`);
    const a = d.json.artifact;
    check("the creating agent is on the artifact", "s17", a.created_by_agent);
    check("with the model", "fake", a.created_by_model);
    check("the harness", "fake", a.created_by_harness);
    check("and the auth profile, by id", "anthropic_personal", a.created_by_auth_profile);
    check("and the project it belongs to", "s17-outputs", a.project_slug);
  }

  // ----------------------------------------------------- the full state path
  console.log("\n=== the full path: generated -> under_review -> ready -> approved -> delivered ===");
  const subject = made.report;
  for (const [action, expected] of [
    ["start_review", "under_review"],
    ["ready", "ready"],
    ["approve", "approved"],
  ] as const) {
    const r = await req("POST", `/api/artifacts/${subject}/review`, { action });
    check(`  ${action} -> ${expected}`, expected, r.json?.state);
  }
  {
    const a = await pool.query<{ state: string; delivered_at: Date | null }>(
      "SELECT state, delivered_at FROM artifacts WHERE id = $1", [subject]);
    check("approved is not delivered", null, a.rows[0].delivered_at);
    ok("...which is the distinction the plan asks the console not to blur");
  }
  {
    const r = await req("POST", `/api/artifacts/${subject}/review`, {
      action: "deliver", target: "sent to Enrique",
    });
    check("  deliver -> delivered", "delivered", r.json?.state);
    const a = await pool.query<{ delivered_at: Date | null; delivery_target: string }>(
      "SELECT delivered_at, delivery_target FROM artifacts WHERE id = $1", [subject]);
    truthy("and the delivery is timestamped", a.rows[0].delivered_at);
    check("with where it went", "sent to Enrique", a.rows[0].delivery_target);
  }
  {
    const bad1 = await req("POST", `/api/artifacts/${subject}/review`, { action: "approve" });
    check("a delivered artifact cannot be approved again", 409, bad1.status);
    check("the machine refuses backwards moves", false, canTransition("delivered", "approved"));
    check("and forwards ones that skip a step", false, canTransition("generated", "approved"));
  }

  // -------------------------------------------- reject with a note -> a task
  console.log("\n=== rejecting with a note is a work instruction, not a status ===");
  const flawed = made.spreadsheet;
  await req("POST", `/api/artifacts/${flawed}/review`, { action: "start_review" });
  {
    const noNote = await req("POST", `/api/artifacts/${flawed}/review`, { action: "reject" });
    check("a rejection with no note is refused", 400, noNote.status);
    truthy("because the note is what the next attempt is built from",
      String(noNote.json?.error?.code) === "note_required");
  }
  const NOTE = "the totals row is wrong — it sums the header as well";
  const rejected = await req("POST", `/api/artifacts/${flawed}/review`, {
    action: "reject", note: NOTE,
  });
  check("with a note it is rejected", "rejected", rejected.json?.state);
  truthy("and a task was created for it", rejected.json?.task_id);
  {
    const t = await pool.query<{ title: string; objective: string; project_id: string; state: string; priority: string }>(
      "SELECT title, objective, project_id, state, priority FROM tasks WHERE id = $1",
      [rejected.json.task_id],
    );
    const task = t.rows[0];
    truthy("the task exists", task);
    check("against the SAME project", projectId, task.project_id);
    truthy("carrying the note verbatim", task.objective.includes(NOTE));
    truthy("and it names the file", task.title.includes("spreadsheet"));
    check("queued, not a note on a shelf", "queued", task.state);
  }

  // ------------------------------------------------------ v2 supersedes v1
  console.log("\n=== a second attempt supersedes the first; both survive ===");
  // A new FILE, not the same one rewritten: both sets of bytes have to survive
  // or the comparison below is comparing something with itself.
  await write("s17/spreadsheet.v2.txt", "a spreadsheet\nline two\nTOTAL 42\n");
  const v2 = await recordArtifact(pool, {
    projectId, path: "s17/spreadsheet.v2.txt", type: "spreadsheet", mime: "text/plain",
    bytes: 40, agent: "s17", model: "fake", supersedes: flawed,
  });
  check("the new one is version 2", 2, v2.version);
  check("and points at what it replaced", flawed, v2.supersedes);
  check(
    "the first is superseded, not deleted",
    "superseded",
    (await pool.query<{ state: string }>("SELECT state FROM artifacts WHERE id = $1", [flawed]))
      .rows[0].state,
  );
  check(
    "both rows are still there",
    2,
    Number((await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM artifacts WHERE path LIKE 's17/spreadsheet%'")).rows[0].n),
  );
  {
    // The guard that makes the history worth having.
    let refused = "";
    await recordArtifact(pool, {
      projectId, path: "s17/spreadsheet.v2.txt", type: "spreadsheet", mime: "text/plain",
      bytes: 40, agent: "s17", supersedes: v2.id,
    }).catch((e: Error) => { refused = e.message; });
    truthy(
      "superseding a version at the SAME path is refused, not silently accepted",
      refused.includes("refusing to supersede"),
    );
    truthy("because the older bytes would be gone", refused.includes("could never be compared"));
  }
  {
    const hist = await lineage(pool, v2.id);
    check("the version history has both, oldest first", "1,2", hist.map((h) => h.version).join(","));
  }

  // ------------------------------------------------------------ compare them
  console.log("\n=== and the two versions can be compared ===");
  {
    const c = await req("GET", `/api/artifacts/${v2.id}/compare?with=${flawed}`);
    check("compare answers", 200, c.status);
    check("with the older one first", 1, c.json?.older?.version);
    check("and the newer second", 2, c.json?.newer?.version);
    check("they are not identical", false, c.json?.identical);
    truthy("and the difference is line-level", Array.isArray(c.json?.diff) && c.json.diff.length > 0);
    truthy(
      "naming what actually changed",
      JSON.stringify(c.json?.diff ?? []).includes("TOTAL 42"),
    );
  }

  // --------------------------------------------------------- the download gate
  console.log("\n=== the download gate ===");
  {
    const d = await req("GET", `/api/artifacts/${made.document}/download`);
    check("a clean artifact downloads", 200, d.status);
    truthy("with its bytes", d.text.includes("a document"));
  }
  {
    const q = await recordArtifact(pool, {
      projectId, path: "s17/suspect.txt", type: "download", mime: "text/plain",
      bytes: 10, quarantineState: "pending", agent: "s17",
    });
    await write("s17/suspect.txt", "possibly nasty\n");
    const d = await req("GET", `/api/artifacts/${q.id}/download`);
    check("a quarantined one cannot be downloaded at all", 403, d.status);
    truthy("and it says why", String(d.json?.error?.code) === "quarantined");
    check("the refusal is audited", true, Number((await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
       WHERE action = 'artifact.download_refused' AND target = $1`, [q.id])).rows[0].n) > 0);
    const detail = await req("GET", `/api/artifacts/${q.id}/detail`);
    check("and its page says quarantined rather than previewing it", "quarantined",
      detail.json?.preview_kind);
  }
  {
    const d = await req("GET", `/api/artifacts/${made.deployment_url}/download`);
    check("a link is not a file, and says so", 409, d.status);
  }

  // ------------------------------------------------------------ fifty of them
  console.log("\n=== fifty artifacts on one project ===");
  for (let i = 0; i < 50; i += 1) {
    await recordArtifact(pool, {
      projectId, path: `s17/bulk-${i}.txt`, type: "report", mime: "text/plain",
      bytes: 5, agent: "s17",
    });
  }
  {
    const page1 = await req("GET", `/api/artifacts?project_id=${projectId}&limit=20&offset=0`);
    const page2 = await req("GET", `/api/artifacts?project_id=${projectId}&limit=20&offset=20`);
    check("the first page holds twenty", 20, page1.json?.artifacts?.length);
    check("and the second another twenty", 20, page2.json?.artifacts?.length);
    const ids1 = new Set((page1.json.artifacts as { id: string }[]).map((a) => a.id));
    check(
      "with no overlap between them",
      0,
      (page2.json.artifacts as { id: string }[]).filter((a) => ids1.has(a.id)).length,
    );
    const total = Number((await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM artifacts WHERE project_id = $1", [projectId])).rows[0].n);
    truthy(`and the project really has ${total} of them`, total >= 50);
  }

  // -------------------------------------------- a task that produced nothing
  console.log("\n=== a task that produced no artifact ===");
  {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id,title,objective,state,lane,priority)
       VALUES ($1,'S17 produced nothing','x','succeeded','heavy','normal') RETURNING id`,
      [projectId],
    );
    const d = await req("GET", `/api/tasks/${t.rows[0].id}`);
    check("the task detail answers", 200, d.status);
    check("with an empty artifact list rather than an error", 0, d.json?.artifacts?.length);
    ok("...which the console renders as a sentence, asserted in the console suite");
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
}

main()
  .catch((err) => { console.error(err); fail += 1; })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    process.exit(fail === 0 ? 0 : 1);
  });

/**
 * S31 — a deliberately hostile MCP server, in a real container.
 *
 * The plan: "A deliberately hostile MCP server cannot escape its container or
 * read another project."
 *
 * So this does not assert the sandbox by reading the flags it passed. It starts
 * a REAL container running a REAL MCP server that actually tries — to open a
 * socket, to write the root filesystem, to write the mount, to read another
 * project's directory, to read the master key — and asserts on what the server
 * reports back through the protocol about what happened. A flag that stopped
 * being passed would show up here as an attempt that succeeded.
 *
 * It runs on the HOST rather than inside the runner container, because it needs
 * Docker. That is also why it is not in the sweep: the sweep's suites run
 * through `docker compose run`, and this one is the wrapper's peer rather than
 * its child.
 *
 * The argv assertions are here too, and they are not redundant with the live
 * ones: the live test proves this image, on this host, under this daemon. The
 * argv test proves the flags are still being passed on a host where, say,
 * user namespaces already made one of them redundant and nobody would notice it
 * going missing.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPool } from "../src/db.js";
import { invokeConnector } from "../src/connectors.js";
import { classifyTool, describeForClassifier, syncTools, toolsFor } from "../src/tools.js";
import { sandboxArgv } from "../src/mcp.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const SLUG = `s31mcp-${Math.random().toString(36).slice(2, 7)}`;
const IMAGE = process.env.S31_MCP_IMAGE ?? "jarvis-dev-runner:latest";

async function main(): Promise<void> {
  console.log("0. the argv carries every flag the boundary depends on");
  const argv = sandboxArgv({ image: "img", command: ["node", "s.js"], projectDir: "/p" });
  const has = (...pair: string[]) => {
    const i = argv.indexOf(pair[0]);
    return i !== -1 && (pair.length === 1 || argv[i + 1] === pair[1]);
  };
  has("--network", "none") ? ok("no network by default") : bad(`network flag: ${argv.join(" ")}`);
  has("--read-only") ? ok("a read-only root filesystem") : bad("the rootfs is writable");
  has("--cap-drop", "ALL") ? ok("every capability dropped") : bad("capabilities are not dropped");
  has("--security-opt", "no-new-privileges") ? ok("no-new-privileges") : bad("setuid can regain privileges");
  has("--user", "1000:1000") ? ok("not root") : bad("the container runs as root");
  has("--pids-limit") && has("--memory") ? ok("bounded pids and memory") : bad("no resource bounds");
  argv.includes("--volume") && argv.includes("/p:/project:ro")
    ? ok("one project directory, mounted read-only")
    : bad(`the mount is wrong: ${argv.join(" ")}`);
  /*
   * The absence that matters most. A container inheriting the runner's
   * environment inherits DATABASE_URL and the master key path, and a server
   * that can read those has no need to escape anything.
   */
  !argv.includes("--env") && !argv.includes("-e") && !argv.some((a) => a.startsWith("--env-file"))
    ? ok("and no environment is passed in at all")
    : bad("the container is handed environment variables");

  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (docker.status !== 0) {
    console.log("");
    console.log("  SKIP - no Docker daemon here; the live half needs one.");
    console.log("");
    console.log(`==== ${passes} passed, ${fails} failed ====`);
    await pool.end();
    process.exit(fails === 0 ? 0 : 1);
  }

  // Two project directories, so "cannot read another project" has another
  // project to fail to read.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s31mcp-"));
  const mine = path.join(root, "mine");
  const theirs = path.join(root, "other");
  await fs.mkdir(mine, { recursive: true });
  await fs.mkdir(theirs, { recursive: true });
  await fs.writeFile(path.join(mine, "mine.txt"), "this project's file");
  await fs.writeFile(path.join(theirs, "theirs.txt"), "the other project's file");
  await fs.copyFile("scripts/fixtures/hostile-mcp-server.mjs", path.join(mine, "server.mjs"));

  const pid = (await pool.query<{ id: string }>(
    `INSERT INTO projects (slug,name,project_type,confidentiality)
     VALUES ($1,$1,'personal','normal') RETURNING id`, [SLUG])).rows[0].id;
  const connId = (await pool.query<{ id: string }>(
    `INSERT INTO connections (slug, kind, scope, project_id, config, permitted_actions, timeout_ms)
     VALUES ($1,'mcp','project',$2,$3,$4,60000) RETURNING id`,
    [SLUG, pid, JSON.stringify({
      image: IMAGE,
      command: ["node", "/project/server.mjs"],
      project_dir: mine,
    }), ["read_anything", "try_escape"]])).rows[0].id;

  console.log("");
  console.log("1. the server's tools are listed over real JSON-RPC");
  const { listSandboxedTools } = await import("../src/mcp.js");
  const listed = await listSandboxedTools({
    image: IMAGE, command: ["node", "/project/server.mjs"], projectDir: mine,
  });
  listed.length === 2
    ? ok(`the handshake and tools/list worked against a container: ${listed.map((t) => t.name).join(", ")}`)
    : bad(`listing returned ${JSON.stringify(listed).slice(0, 120)}`);

  console.log("");
  console.log("2. its tools are inert until classified, hostile descriptions and all");
  await syncTools(pool, connId, listed.map((t) => ({
    name: t.name, description: t.description ?? null, inputSchema: t.inputSchema ?? null,
  })));
  const early = await invokeConnector(pool, {
    connectionSlug: SLUG, action: "try_escape", projectId: pid,
  });
  !early.ok && early.reason.includes("not been classified")
    ? ok("a real server's tool is refused before classification")
    : bad(`an unclassified tool ran: ${JSON.stringify(early).slice(0, 90)}`);
  const stored = await toolsFor(pool, connId);
  const hostileDesc = stored.find((t) => t.name === "read_anything")?.description ?? "";
  hostileDesc.includes("SSH key")
    ? ok("the hostile description is stored in full, for a classifier to read")
    : bad("the description was not stored");
  !`${describeForClassifier({ name: "read_anything", description: hostileDesc })}`.includes("SSH key")
    ? ok("and rendered so a careless interpolation cannot repeat its instruction")
    : bad("the description leaks when interpolated");

  console.log("");
  console.log("3. classified, it runs — and it cannot get out");
  for (const t of stored) {
    await classifyTool(pool, { connectionId: connId, name: t.name, level: 1, by: "enrique" });
  }
  const escaped = await invokeConnector(pool, {
    connectionSlug: SLUG, action: "try_escape", projectId: pid,
  });
  if (!escaped.ok) {
    bad(`the call failed outright: ${escaped.reason}`);
  } else {
    const report = (escaped.output as { data?: { content?: Record<string, string> } })
      ?.data?.content ?? {};
    console.log(`       the server reported: ${JSON.stringify(report)}`);
    String(report.network).startsWith("blocked")
      ? ok(`it tried to open a socket and could not: ${report.network}`)
      : bad(`the container reached the network: ${report.network}`);
    String(report.rootfs).startsWith("blocked")
      ? ok(`it tried to write the root filesystem and could not: ${report.rootfs}`)
      : bad(`the root filesystem is writable: ${report.rootfs}`);
    String(report.project_write).startsWith("blocked")
      ? ok(`it tried to write the mounted project and could not: ${report.project_write}`)
      : bad(`the project mount is writable: ${report.project_write}`);
    report.own_project === "this project's file"
      ? ok("while the project it WAS given is readable, so the mount is doing its job")
      : bad(`its own project is unreadable: ${report.own_project}`);
    String(report.other_project).startsWith("unreadable")
      ? ok(`and the other project is not there to read: ${report.other_project}`)
      : bad(`IT READ ANOTHER PROJECT: ${report.other_project}`);
    String(report.master_key).startsWith("unreadable")
      ? ok(`the master key is not reachable: ${report.master_key}`)
      : bad(`THE MASTER KEY WAS READABLE: ${report.master_key}`);
    report.uid !== 0
      ? ok(`and it is not root inside the container (uid ${report.uid})`)
      : bad("the server runs as root");
    /*
     * The one it CAN read, and the one I nearly shipped unasserted.
     * /proc/1/environ inside the container is the server's own environment, so
     * it always reads - the question was never whether it could, but what is in
     * it. Names only: a leak must be detectable without the value reaching a
     * log. If the launcher ever starts passing the runner's environment through,
     * this is where it shows up.
     */
    const names = String(report.env_names ?? "").split(",");
    const leaked = names.filter((n) => /^(DATABASE_URL|MASTER_KEY_PATH|INTERNAL_HMAC|POSTGRES_|JARVIS_|AWS_|OPENAI_|ANTHROPIC_)/.test(n));
    leaked.length === 0
      ? ok(`its environment carries nothing of ours: ${report.env_names}`)
      : bad(`the container inherited ${leaked.join(", ")}`);
  }

  console.log("");
  console.log("4. its response is data, and nothing acted on it");
  const answer = await invokeConnector(pool, {
    connectionSlug: SLUG, action: "read_anything", projectId: pid,
    input: { path: "/project/mine.txt" },
  });
  answer.ok && (answer.output as { untrusted?: boolean }).untrusted === true
    ? ok("a real server's response comes back labelled untrusted")
    : bad(`the response is not labelled: ${JSON.stringify(answer).slice(0, 90)}`);

  await pool.query(`DELETE FROM audit_events WHERE project_id = $1`, [pid]);
  await pool.query(`DELETE FROM connection_tools WHERE connection_id = $1`, [connId]);
  await pool.query(`DELETE FROM connections WHERE id = $1`, [connId]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [pid]);
  await fs.rm(root, { recursive: true, force: true });

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  await pool.end();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  await pool.end().catch(() => undefined);
  process.exit(1);
});

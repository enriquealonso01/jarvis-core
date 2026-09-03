/**
 * Publish the build bar by PULLING from the repository, on the box's own clock.
 *
 *   node --import tsx scripts/publish-progress-pull.ts [ref]
 *
 * The existing publish script runs on Enrique's workstation and pushes over
 * scp, which means the bar is only as fresh as the last time a human
 * remembered to run it. It went 21 hours stale, and at the time of writing this
 * the box was serving a copy nearly three hours old, which is the same failure
 * arriving more quietly.
 *
 * A push from a workstation cannot be structural: the workstation is not always
 * on, and nothing on the box knows it is behind. So the direction is reversed.
 * The box reads the two files straight from the repository with the admin token
 * it already holds, and a timer decides how often. Nobody has to remember
 * anything, and the bar is stale only if the timer is dead - which is a visible
 * condition rather than an invisible one.
 *
 * Deliberately NOT a git clone: two files are wanted, not a working tree, and a
 * checkout on the box is one more thing that can end up on the wrong branch.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createPool } from "../src/db.js";
import { githubReadFile } from "../src/github.js";

const pool = createPool();
const REF = process.argv[2] ?? "main";
const DEST = process.env.JARVIS_STATE_DIR ?? "/var/lib/jarvis/state";
const OWNER = process.env.JARVIS_REPO_OWNER ?? "enriquealonso01";
const REPO = process.env.JARVIS_REPO_NAME ?? "jarvis-core";
/*
 * Overridable only so the live check can aim the publisher at a file that is
 * NOT valid JSON and prove the guard below actually guards. There is no other
 * reason to change it.
 */
const PROGRESS_FILE = process.env.JARVIS_PROGRESS_FILE ?? "PROGRESS.json";

/**
 * Written beside the target and renamed.
 *
 * The API reads these on every request, so a partial write is a served partial
 * write. Rename within the same directory is atomic; write-in-place is not.
 */
async function placeAtomically(dir: string, name: string, body: string): Promise<void> {
  const target = path.join(dir, name);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.chmod(tmp, 0o644);
  await fs.rename(tmp, target);
}

async function main(): Promise<void> {
  await fs.mkdir(DEST, { recursive: true });

  const progress = await githubReadFile(pool, OWNER, REPO, PROGRESS_FILE, REF);
  const blocked = await githubReadFile(pool, OWNER, REPO, "BLOCKED.md", REF);

  /*
   * Parsed before it is published, and the run fails if it does not parse.
   *
   * Serving a truncated or half-written PROGRESS.json breaks the console's
   * build bar for everyone, and it would do so silently on a timer nobody is
   * watching. Better to keep yesterday's valid file and fail loudly.
   */
  const parsed = JSON.parse(progress) as { total_steps?: number; steps?: unknown[] };
  if (!Array.isArray(parsed.steps) || !parsed.steps.length) {
    throw new Error("PROGRESS.json parsed but has no steps; refusing to publish it");
  }

  const before = await fs.readFile(path.join(DEST, "PROGRESS.json"), "utf8").catch(() => "");
  await placeAtomically(DEST, "PROGRESS.json", progress);
  await placeAtomically(DEST, "BLOCKED.md", blocked);

  const changed = before !== progress;
  console.log(
    `published ${OWNER}/${REPO}@${REF}: ${parsed.steps.length} steps`
    + `${changed ? " (changed)" : " (unchanged)"}`,
  );
}

main()
  .catch((e) => {
    console.error(`publish failed: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  })
  .finally(async () => { await pool.end().catch(() => undefined); });

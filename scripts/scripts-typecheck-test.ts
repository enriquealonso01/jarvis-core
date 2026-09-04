/**
 * The suites are under the typechecker, and stay under it.
 *
 * `tsconfig.json` includes only `src/**` — it is also the build config, and
 * `dist/` must not grow a `scripts/` directory — so about a hundred and fifty
 * suites sat outside type checking entirely. Nobody had noticed, because a suite
 * that does not compile still RUNS: `tsx` strips the types and executes it.
 *
 * That is not a tidiness problem. The first run of the wider config found eight
 * errors in six files and THREE OF THEM WERE ASSERTIONS THAT COULD NOT FAIL, in
 * suites that were reporting green:
 *
 *   - `s31-mcp-test` checked `report.uid !== 0` against a STRING, so "it is not
 *     root inside the container" was true for every possible value, "0"
 *     included. A security assertion that asserted nothing.
 *   - `s54-selfdeploy-test` read `.ready` off an un-narrowed union, so it was
 *     `undefined` and `!undefined` was true whatever `deployShapeFor` did.
 *   - `s51-homemap-test` filtered a literal it had written two lines above, for
 *     kinds that are not in the union at all.
 *
 * And two were real fixture bugs: a `kind: "api_key"` that is not an
 * `ActionKind` (the real one is `provide_api_key`), and a `channel: "phone"`
 * passed to `ingestUserMessage`, which does not take one, so the voice e2e was
 * silently ingesting as if typed.
 *
 * This runs the check rather than trusting that somebody ran it. `dev-rebuild`
 * gates on it too, but dev-rebuild is not what runs in the sweep.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const NEWLINE = String.fromCharCode(10);
const ROOT = new URL("../", import.meta.url);

function tsc(project: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("npx", ["tsc", "--noEmit", "-p", project], {
      cwd: ROOT.pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      shell: process.platform === "win32",
    });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

async function main(): Promise<void> {
  console.log("1. the wider config exists and covers the suites");
  const cfg = JSON.parse(await fs.readFile(new URL("tsconfig.scripts.json", ROOT), "utf8")) as {
    include?: string[]; compilerOptions?: Record<string, unknown>;
  };
  (cfg.include ?? []).some((i) => i.startsWith("scripts/"))
    ? ok("tsconfig.scripts.json includes scripts/")
    : bad(`it does not cover the suites: ${JSON.stringify(cfg.include)}`);
  (cfg.include ?? []).some((i) => i.startsWith("src/"))
    ? ok("and src/ with them, so a suite is checked against the real types rather than a copy")
    : bad("src/ is not in the same program, so the suites check against nothing");
  cfg.compilerOptions?.noEmit === true
    ? ok("and it never emits, so it cannot quietly become a second build")
    : bad("the checking config emits");

  console.log("");
  console.log("2. and the suites pass it");
  /*
   * The whole point. Asserted by RUNNING the compiler rather than by reading the
   * config, because a config that covers everything and is never run covers
   * nothing.
   */
  const result = await tsc("tsconfig.scripts.json");
  const errors = result.out.split(NEWLINE).filter((l) => /error TS[0-9]+/.test(l));
  errors.length === 0
    ? ok("scripts/ and src/ typecheck clean")
    : bad(`${errors.length} type errors:${NEWLINE}    ${errors.slice(0, 12).join(`${NEWLINE}    `)}`);
  result.code === 0
    ? ok("and the compiler agrees, by its exit code")
    : bad(`tsc exited ${result.code}`);

  console.log("");
  console.log("3. the build config is still only the build config");
  /*
   * If somebody "fixes" this by adding scripts/ to tsconfig.json, `pnpm build`
   * starts emitting dist/scripts and dist/src instead of dist/*.js — every
   * import path in the image moves, and the containers stop starting. That is a
   * worse failure than the one this guards, so it is checked in the other
   * direction too.
   */
  const build = JSON.parse(await fs.readFile(new URL("tsconfig.json", ROOT), "utf8")) as {
    include?: string[]; compilerOptions?: Record<string, unknown>;
  };
  !(build.include ?? []).some((i) => i.startsWith("scripts/"))
    ? ok("tsconfig.json still builds src/ only, so dist/ keeps its shape")
    : bad("scripts/ was added to the BUILD config — dist/ moves and the containers stop starting");
  build.compilerOptions?.rootDir === "src"
    ? ok("with rootDir still src")
    : bad(`rootDir is ${String(build.compilerOptions?.rootDir)}`);

  console.log("");
  console.log("4. and the gate that keeps it true");
  const rebuild = await fs.readFile(new URL("scripts/dev-rebuild.sh", ROOT), "utf8");
  const code = rebuild.split(NEWLINE).filter((l) => !/^\s*#/.test(l)).join(NEWLINE);
  /tsc -p tsconfig\.scripts\.json/.test(code)
    ? ok("dev-rebuild typechecks the suites before it builds anything")
    : bad("dev-rebuild still checks src/ only, so a broken suite ships");
  /*
   * Asserted as the CONSEQUENCE rather than as a line in the Dockerfile: the
   * image does not COPY deploy/, so reading the Dockerfile from inside it threw
   * ENOENT. What matters is that the config is here — which is only true if
   * the image was told to bring it.
   */
  await fs.access(new URL("tsconfig.scripts.json", ROOT))
    .then(() => ok("and the config is present wherever this runs, image included"))
    .catch(() => bad("tsconfig.scripts.json is not here, so this suite could not have checked anything"));

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});

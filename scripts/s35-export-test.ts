/**
 * S35 — the export gate, and the key that must not travel.
 *
 *   "Attempt an export from a task, and by voice → refused both times. Then
 *    complete one from the console with re-auth, so the test proves a GATE
 *    rather than a wall."
 *
 *   "Open the archive with the passphrase, then confirm no key inside it would
 *    have done. **Encryption whose key ships alongside it is what this test
 *    exists to catch.**"
 *
 *   "Check the manifest against the extracted tree, **and the tree against
 *    reality** — a manifest that agrees with itself proves nothing."
 *
 * The second of those is the one worth being careful about. "It decrypts with
 * the passphrase" is true of a scheme that also ships the key; the assertion
 * has to be that nothing IN the archive opens it, which means actually trying
 * every candidate the archive contains.
 */
import crypto from "node:crypto";
import { createPool } from "../src/db.js";
import {
  auditExport, deriveKey, exportPathIsSafe, mayExport, MIN_PASSPHRASE,
  openArchive, REQUIRED_SECTIONS, sealArchive, verifyManifest, type Manifest,
} from "../src/exportarchive.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const PASSPHRASE = "correct horse battery staple";

async function main(): Promise<void> {
  try {
    console.log("1. the gate refuses on WHO is asking, first");
    const fromTask = mayExport({ initiator: "task", reauthFresh: true, passphrase: PASSPHRASE });
    !fromTask.allowed && fromTask.reason.includes("not something a task can start")
      ? ok(`a task with a fresh session and a good passphrase is still refused: "${fromTask.reason}"`)
      : bad(`a task produced an export: ${JSON.stringify(fromTask)}`);
    const byVoice = mayExport({ initiator: "voice", reauthFresh: true, passphrase: PASSPHRASE });
    !byVoice.allowed && byVoice.reason.includes("never be authorised by voice")
      ? ok("and by voice it is refused for being voice, not for anything it could fix")
      : bad("voice authorised an export");
    !mayExport({ initiator: "jarvis", reauthFresh: true, passphrase: PASSPHRASE }).allowed
      ? ok("Jarvis cannot start one itself")
      : bad("Jarvis initiated an export");
    !mayExport({ initiator: "api", reauthFresh: true, passphrase: PASSPHRASE }).allowed
      ? ok("and neither can a bare API call")
      : bad("an API call started an export");
    /*
     * The ordering matters and is asserted: a task holding a fresh session is
     * refused for BEING A TASK. A gate that checked credentials first would let
     * an injected agent argue about credentials.
     */
    fromTask.allowed === false && !fromTask.reason.includes("re-auth")
      ? ok("the refusal is about the initiator, not about credentials it might obtain")
      : bad("the task refusal talks about credentials, so the order is wrong");

    console.log("");
    console.log("2. but it is a gate, not a wall");
    !mayExport({ initiator: "user_console", reauthFresh: false, passphrase: PASSPHRASE }).allowed
      ? ok("the console without a fresh re-auth is refused")
      : bad("a stale console session exported");
    const shortPass = mayExport({ initiator: "user_console", reauthFresh: true, passphrase: "short" });
    !shortPass.allowed && shortPass.reason.includes(String(MIN_PASSPHRASE))
      ? ok("and a weak passphrase is refused, since it is the only thing left behind")
      : bad("a five-character passphrase was accepted");
    mayExport({ initiator: "user_console", reauthFresh: true, passphrase: PASSPHRASE }).allowed
      ? ok("the console, re-authenticated, with a real passphrase, is allowed — so this is a gate")
      : bad("the legitimate path was refused, which makes it a wall");

    console.log("");
    console.log("3. the archive opens with the passphrase");
    const payload = Buffer.from(JSON.stringify({
      database: "…rows…",
      encrypted_secrets: { canary: "…ciphertext…" },
      master_key_path: "/var/lib/jarvis/keys/master.key",
    }));
    const archive = sealArchive(payload, PASSPHRASE);
    openArchive(archive, PASSPHRASE).toString() === payload.toString()
      ? ok("it decrypts to exactly what went in")
      : bad("the archive did not round-trip");
    let wrongFailed = false;
    try {
      openArchive(archive, "the wrong passphrase entirely");
    } catch {
      wrongFailed = true;
    }
    wrongFailed ? ok("and the wrong passphrase fails") : bad("any passphrase opened it");

    console.log("");
    console.log("4. and NO key inside it would have done");
    /*
     * The assertion the plan asks for, done by actually trying. "It decrypts
     * with the passphrase" is equally true of a scheme that ships the key
     * alongside, so every candidate the archive carries is fed to the opener
     * and must fail.
     *
     * The header travels with the archive by necessity - a salt and a nonce are
     * not secrets - so those are the first candidates, and the payload's own
     * contents are the rest.
     */
    const candidates: { what: string; value: string }[] = [
      { what: "the salt from the header", value: archive.header.salt },
      { what: "the nonce from the header", value: archive.header.nonce },
      { what: "the algorithm name", value: archive.header.algorithm },
      { what: "the creation timestamp", value: archive.header.createdAt },
      { what: "the whole header as JSON", value: JSON.stringify(archive.header) },
      { what: "the master key path named in the payload", value: "/var/lib/jarvis/keys/master.key" },
      { what: "the ciphertext itself", value: archive.ciphertext.toString("base64") },
    ];
    const opened: string[] = [];
    for (const c of candidates) {
      try {
        openArchive(archive, c.value);
        opened.push(c.what);
      } catch { /* refused, which is the point */ }
    }
    opened.length === 0
      ? ok(`none of the ${candidates.length} things travelling with the archive opens it`)
      : bad(`the archive was opened by ${opened.join(", ")} — the key ships alongside it`);
    /*
     * And the derivation itself: two archives of the same payload under the
     * same passphrase must differ, or the salt is not doing its job and a
     * precomputed table opens every export he has ever made.
     */
    const second = sealArchive(payload, PASSPHRASE);
    archive.header.salt !== second.header.salt
      && !archive.ciphertext.equals(second.ciphertext)
      ? ok("two exports of the same data differ, so the salt is per-archive")
      : bad("two exports are byte-identical, so one table opens all of them");
    !deriveKey(PASSPHRASE, Buffer.from(archive.header.salt, "base64"))
      .equals(deriveKey(PASSPHRASE, Buffer.from(second.header.salt, "base64")))
      ? ok("and the same passphrase derives a different key under a different salt")
      : bad("the salt does not affect the derived key");

    console.log("");
    console.log("5. the manifest is checked against the tree, and the tree against reality");
    const full = (): Manifest => ({
      createdAt: new Date().toISOString(),
      sections: Object.fromEntries(REQUIRED_SECTIONS.map((s) => [s, { entries: [`${s}-a`], bytes: 10 }])),
    });
    const tree = Object.fromEntries(REQUIRED_SECTIONS.map((s) => [s, [`${s}-a`]]));
    verifyManifest(full(), tree, tree).length === 0
      ? ok("a complete archive checks out three ways")
      : bad(`a complete archive reported problems: ${JSON.stringify(verifyManifest(full(), tree, tree))}`);

    // v1's failure: a whole section simply absent, and nobody noticed.
    const noDb = full();
    delete noDb.sections.database;
    const missingSection = verifyManifest(noDb, tree, tree);
    missingSection.some((p) => p.section === "database")
      ? ok(`a manifest with no database section is caught: "${missingSection[0].problem}"`)
      : bad("the archive with no database passed");

    /*
     * The self-consistent case, which is the one the plan says proves nothing
     * if you only compare two of the three: manifest and tree agree perfectly,
     * and the live system has a project neither of them mentions.
     */
    const realityHasMore = { ...tree, repositories: ["repositories-a", "jarvis-proof-01"] };
    const selfConsistent = verifyManifest(full(), tree, realityHasMore);
    selfConsistent.some((p) => p.section === "repositories" && p.problem.includes("the system has"))
      ? ok(`a manifest that agrees with the tree is still caught against reality: "${selfConsistent[0].problem}"`)
      : bad("a self-consistent manifest hid a repository that was never backed up");

    // And the opposite: the manifest claims something the archive lacks.
    const shortTree = { ...tree, artifacts: [] };
    verifyManifest(full(), shortTree, tree).some((p) => p.section === "artifacts")
      ? ok("and a manifest claiming entries the archive does not have is caught too")
      : bad("a manifest overclaiming went unnoticed");

    console.log("");
    console.log("6. it does not land in the artifact store");
    exportPathIsSafe("/var/lib/jarvis/exports/jarvis-2026-09-04.age", "/var/lib/jarvis/artifacts")
      ? ok("an export written outside artifacts/ is fine")
      : bad("a safe path was rejected");
    !exportPathIsSafe("/var/lib/jarvis/artifacts/abc/jarvis.age", "/var/lib/jarvis/artifacts")
      ? ok("and one inside it is refused — every credential behind the ordinary download gate, indexed by search")
      : bad("an export inside artifacts/ was allowed");

    console.log("");
    console.log("7. its existence is audited, even though its contents are not");
    await auditExport(pool, {
      path: "/var/lib/jarvis/exports/test.age", bytes: 1234, sections: [...REQUIRED_SECTIONS],
    });
    const row = (await pool.query<{ actor: string; metadata: Record<string, unknown> }>(
      `SELECT actor, metadata FROM audit_events WHERE action = 'export.produced'
        ORDER BY at DESC LIMIT 1`)).rows[0];
    row?.actor === "user"
      ? ok("an audit row records that an export was produced")
      : bad("no audit row for the export");
    !JSON.stringify(row?.metadata ?? {}).includes(PASSPHRASE)
      ? ok("and the passphrase is nowhere in it")
      : bad("THE PASSPHRASE IS IN THE AUDIT ROW");
  } finally {
    await pool.query(`DELETE FROM audit_events WHERE action = 'export.produced'`);
  }

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

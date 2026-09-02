/**
 * Which credentials a confidential project may use.
 *
 * Enrique decided this, and it is the kind of rule that is easy to state and
 * easy to lose: a confidential project may use all PAID models and no free
 * tier, because a free tier is paid for with the data you send it.
 *
 * Every profile started at {normal}, which meant a confidential project could
 * use NOTHING - the rule was not merely unenforced, it was inverted into a
 * total block that nobody would notice until the first confidential project
 * tried to run.
 */
import { createPool } from "../src/db.js";
import { checkProfileAccess } from "../src/isolation.js";

const PAID = ["anthropic_personal", "cursor_personal", "openai_codex_personal", "fireworks"];
const FREE = ["groq", "nvidia", "google_ai"];

let fails = 0;
const ok = (m: string) => console.log(`  ok   - ${m}`);
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails++; };

async function main() {
  const pool = createPool();
  const mk = async (confidentiality: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, slug, confidentiality, project_type)
       VALUES ($1, $2, $3, 'professional') RETURNING id`,
      [`elig-${confidentiality}-${Date.now()}`, `elig-${confidentiality}-${Date.now()}`, confidentiality],
    );
    const id = r.rows[0].id;
    /*
     * Allowlist every profile onto the project.
     *
     * Eligibility is only ONE of two gates - a profile must also be allowlisted
     * for the project - and the first version of this test left the allowlist
     * empty, so every answer was "not allowlisted" and the eligibility rule was
     * never exercised at all. Granting the allowlist makes confidentiality the
     * only variable, which is the thing under test.
     */
    for (const profile of [...PAID, ...FREE]) {
      await pool.query(
        `INSERT INTO auth_profile_allowlists (auth_profile_id, project_id, allowed_roles)
         VALUES ($1, $2, ARRAY[]::text[]) ON CONFLICT DO NOTHING`,
        [profile, id],
      );
    }
    return id;
  };

  const confidential = await mk("confidential");
  const normal = await mk("normal");
  const restricted = await mk("restricted");

  console.log("1. a confidential project is granted every PAID model");
  for (const id of PAID) {
    const d = await checkProfileAccess(pool, { authProfileId: id, projectId: confidential });
    d.allowed ? ok(`${id} allowed`) : bad(`${id} refused: ${d.reason}`);
  }

  console.log("2. a confidential project is refused every FREE tier");
  for (const id of FREE) {
    const d = await checkProfileAccess(pool, { authProfileId: id, projectId: confidential });
    !d.allowed ? ok(`${id} refused: ${d.reason}`) : bad(`${id} was ALLOWED on a confidential project`);
  }

  console.log("3. a normal project still uses the free tiers");
  for (const id of FREE) {
    const d = await checkProfileAccess(pool, { authProfileId: id, projectId: normal });
    d.allowed ? ok(`${id} allowed`) : bad(`${id} refused on a normal project: ${d.reason}`);
  }

  console.log("4. restricted was not part of the decision, so nothing is eligible");
  for (const id of [...PAID, ...FREE]) {
    const d = await checkProfileAccess(pool, { authProfileId: id, projectId: restricted });
    if (d.allowed) { bad(`${id} was allowed on a RESTRICTED project without anyone deciding that`); }
  }
  ok("no profile is eligible for restricted");

  console.log("5. a new profile defaults to normal only");
  await pool.query(
    `INSERT INTO auth_profiles (id, provider, display_name, auth_type, health)
     VALUES ('elig_probe', 'probe', 'Eligibility probe', 'api_key', 'healthy')
     ON CONFLICT (id) DO NOTHING`,
  );
  const probe = await pool.query<{ e: string[] }>(
    `SELECT confidentiality_eligibility AS e FROM auth_profiles WHERE id = 'elig_probe'`,
  );
  const e = probe.rows[0]?.e ?? [];
  JSON.stringify(e) === JSON.stringify(["normal"])
    ? ok("defaults to {normal}, widened on purpose")
    : bad(`a new profile defaulted to ${JSON.stringify(e)}`);

  await pool.query(`DELETE FROM auth_profiles WHERE id = 'elig_probe'`);
  await pool.query(`DELETE FROM auth_profile_allowlists WHERE project_id = ANY($1)`,
    [[confidential, normal, restricted]]);
  await pool.query(`DELETE FROM projects WHERE id = ANY($1)`, [[confidential, normal, restricted]]);
  await pool.end();

  console.log(fails === 0 ? "\nConfidential eligibility PASS" : `\nConfidential eligibility FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

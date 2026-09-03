/**
 * S18b — an expired link offers a fresh one, delivered to WhatsApp.
 *
 *   "Let a link expire, then open it → offered a fresh one, **delivered to
 *    WhatsApp rather than rendered on the page.**"
 *
 * The delivery channel IS the authentication, which is what makes the second
 * half of that sentence the load-bearing one. Whoever is holding an expired
 * link is not necessarily him: a two-hour token that has since lapsed may have
 * been forwarded, screenshotted, or left in a browser somebody else uses.
 * Rendering the replacement would hand a fresh two hours to whoever asked.
 *
 * So the central assertion is an absence, and it is checked against the WHOLE
 * response body rather than against the field the token would obviously go in -
 * a token that leaked through some other key would pass the narrow version.
 */
import { createPool } from "../src/db.js";

const pool = createPool();
let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

const API = process.env.S18B_API ?? "http://api:8080";
const TAG = `s18br-${Math.random().toString(36).slice(2, 7)}`;

async function main(): Promise<void> {
  const issueId = (await pool.query<{ id: string }>(
    `INSERT INTO issues (severity, category, status, owner, title, dedupe_key)
     VALUES ('high','auth.handoff','waiting_for_user','user',$1,$2) RETURNING id`,
    [`${TAG} sign in to the supplier portal`, `${TAG}:handoff`])).rows[0].id;

  try {
    const { ensureActionRequest } = await import("../src/actions.js");
    const first = await ensureActionRequest(pool, {
      issueId, kind: "api_key", title: `${TAG} supplier key`,
      message: "The supplier portal needs a key.", ttlHours: 2,
    });
    first.token ? ok("a link was issued") : bad("no token was issued");

    console.log("");
    console.log("1. while it is live, asking for another is refused");
    const early = await fetch(`${API}/api/action-requests/${first.id}/reissue`, { method: "POST" });
    const earlyBody = await early.json() as { error?: string; state?: string };
    early.status === 409 && earlyBody.state === "pending"
      ? ok(`a working link is not replaced: "${earlyBody.error}"`)
      : bad(`a live link was re-issued: ${early.status} ${JSON.stringify(earlyBody)}`);

    console.log("");
    console.log("2. expire it, and a fresh one is offered");
    await pool.query(
      `UPDATE user_action_requests SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [first.id]);
    await pool.query(`DELETE FROM unprompted_messages WHERE reason = 'auth_handoff'`);

    const res = await fetch(`${API}/api/action-requests/${first.id}/reissue`, { method: "POST" });
    const raw = await res.text();
    const body = JSON.parse(raw) as { reissued?: boolean; delivered?: string; message?: string };
    res.status === 200 && body.reissued === true
      ? ok("an expired link is re-issued rather than refused")
      : bad(`the expired link was not re-issued: ${res.status} ${raw.slice(0, 120)}`);
    body.delivered === "whatsapp"
      ? ok("and the response says where it went")
      : bad(`delivered=${body.delivered}`);

    console.log("");
    console.log("3. and the new token is NOT on the page");
    const fresh = (await pool.query<{ id: string; token_hash: Buffer }>(
      `SELECT id, token_hash FROM user_action_requests
        WHERE issue_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 1`,
      [issueId, first.id])).rows[0];
    /*
     * Guarded, because a sabotage that EXTENDS the old request instead of
     * replacing it leaves no new row - and the first version of this then threw
     * on `fresh.id`, so the suite reported one failure and crashed before the
     * three assertions that matter most. A test that stops at the first problem
     * hides the rest of them.
     */
    fresh ? ok(`a new request row exists (${fresh.id.slice(0, 8)})`) : bad("no new request was created");
    const freshId = fresh?.id ?? "<none>";
    /*
     * The absence, checked against the whole body rather than against the field
     * a token would obviously live in. A leak through some other key would pass
     * the narrow version of this.
     */
    !raw.includes(freshId)
      ? ok("the response does not even name the new request")
      : bad("the new request id is in the response body");
    const queued = (await pool.query<{ link: string | null }>(
      `SELECT link FROM unprompted_messages WHERE reason = 'auth_handoff'
        ORDER BY wanted_at DESC LIMIT 1`)).rows[0];
    queued?.link?.includes(freshId)
      ? ok("while the queued WhatsApp message carries the link")
      : bad(`the message has no link: ${queued?.link}`);
    const token = queued?.link?.split("t=")[1] ?? "";
    token.length > 20 && !raw.includes(token)
      ? ok("and the token itself appears nowhere in the HTTP response")
      : bad("THE NEW TOKEN WAS RENDERED ON THE PAGE");

    console.log("");
    console.log("4. it goes through the closed list, not around it");
    const reason = (await pool.query<{ reason: string }>(
      `SELECT reason FROM unprompted_messages ORDER BY wanted_at DESC LIMIT 1`)).rows[0];
    reason?.reason === "auth_handoff"
      ? ok("queued as auth_handoff, which is already a reason Jarvis may open a conversation")
      : bad(`queued as ${reason?.reason}, outside the closed list`);

    console.log("");
    console.log("5. the old token stays dead");
    const stillExpired = (await pool.query<{ expires_at: string }>(
      `SELECT expires_at::text FROM user_action_requests WHERE id = $1`, [first.id])).rows[0];
    new Date(stillExpired.expires_at) < new Date()
      ? ok("the expired request was not extended — a new row, so every copy of the old link stays dead")
      : bad("the old link was revived");

    console.log("");
    console.log("6. a consumed link is finished, not re-issuable");
    await pool.query(`UPDATE user_action_requests SET consumed_at = now() WHERE id = $1`, [freshId === "<none>" ? first.id : freshId]);
    const afterUse = await fetch(`${API}/api/action-requests/${freshId === "<none>" ? first.id : freshId}/reissue`, { method: "POST" });
    const usedBody = await afterUse.json() as { error?: string };
    afterUse.status === 409 && usedBody.error?.includes("already used")
      ? ok(`a used link is not reopened: "${usedBody.error}"`)
      : bad(`a consumed link was re-issued: ${afterUse.status}`);

    console.log("");
    console.log("7. the re-issue is audited");
    const aud = (await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_events WHERE action = 'action_request.reissued'`)).rows[0];
    Number(aud.n) >= 1 ? ok("an audit row records it") : bad("the re-issue left no audit row");
  } finally {
    await pool.query(`DELETE FROM unprompted_messages WHERE reason = 'auth_handoff'`);
    await pool.query(`DELETE FROM audit_events WHERE action = 'action_request.reissued'`);
    await pool.query(`DELETE FROM user_action_requests WHERE issue_id = $1`, [issueId]);
    await pool.query(`DELETE FROM issues WHERE id = $1`, [issueId]);
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

/**
 * S32 — each tier against a site that needs exactly that tier.
 *
 *   "Each tier individually against a site that requires exactly that tier.
 *    Assert the escalation actually happens and is recorded."
 *
 * The assertions are on WHICH RUNGS WERE TRIED, not only on which one served.
 * "The browser got the page" is true both of a ladder that climbed properly and
 * of one that started at the top — and those cost different amounts, which is
 * the entire subject of this part of the plan.
 */
import {
  explainLadder, fetchByLadder, httpTier, TIER_ORDER,
  type FetchOutcome, type HeavySlot, type Tier, type TierImpl,
} from "../src/fetchtier.js";

let passes = 0;
let fails = 0;
const ok = (m: string) => { console.log(`  ok   - ${m}`); passes += 1; };
const bad = (m: string) => { console.log(`  FAIL - ${m}`); fails += 1; };

/** A site that only answers a given tier, and records who asked. */
function siteNeeding(tier: Tier, log: Tier[]): Partial<Record<Tier, TierImpl>> {
  const impl = (t: Tier): TierImpl => async () => {
    log.push(t);
    if (t === tier) return { ok: true, body: `<html>served by ${t}</html>`, status: 200 };
    return { ok: false, retryable: true, reason: t === "http" ? "HTTP 403" : "still blocked" };
  };
  return { http: impl("http"), fingerprinted: impl("fingerprinted"), browser: impl("browser") };
}

const SLOT: HeavySlot = { heldBy: "s32-tiers-test", acquiredAt: new Date() };

async function main(): Promise<void> {
  console.log("1. the cheapest rung is always tried first");
  {
    const log: Tier[] = [];
    const r = await fetchByLadder("https://x/", { impls: siteNeeding("http", log), heavySlot: SLOT });
    r.servedBy === "http" && log.length === 1
      ? ok("a static page is served by plain HTTP, and nothing else is tried")
      : bad(`servedBy=${r.servedBy} after trying ${log.join(", ")}`);
  }

  console.log("");
  console.log("2. escalation happens, and only on failure");
  {
    const log: Tier[] = [];
    const r = await fetchByLadder("https://x/", { impls: siteNeeding("fingerprinted", log), heavySlot: SLOT });
    r.servedBy === "fingerprinted"
      ? ok("a site that rejects stock clients is served by the fingerprinted rung")
      : bad(`servedBy=${r.servedBy}`);
    log.join(",") === "http,fingerprinted"
      ? ok(`and it got there by climbing: ${log.join(" → ")}`)
      : bad(`the rungs tried were ${log.join(", ")}`);
    r.attempts[0]?.outcome === "refused" && r.attempts[0].reason.includes("403")
      ? ok(`with the refusal recorded: "${r.attempts[0].reason}"`)
      : bad(`the first attempt was not recorded as a refusal: ${JSON.stringify(r.attempts[0])}`);
  }
  {
    const log: Tier[] = [];
    const r = await fetchByLadder("https://x/", { impls: siteNeeding("browser", log), heavySlot: SLOT });
    r.servedBy === "browser" && log.join(",") === "http,fingerprinted,browser"
      ? ok(`a JavaScript page reaches the browser only after both cheaper rungs refused: ${log.join(" → ")}`)
      : bad(`servedBy=${r.servedBy} after ${log.join(", ")}`);
    explainLadder(r).includes("http: refused")
      ? ok(`and the explanation names what was tried: "${explainLadder(r)}"`)
      : bad(`the explanation does not show the path: ${explainLadder(r)}`);
  }

  console.log("");
  console.log("3. a final answer is not escalated past");
  {
    const log: Tier[] = [];
    const impls: Partial<Record<Tier, TierImpl>> = {
      http: async () => { log.push("http"); return { ok: false, retryable: false, reason: "HTTP 404" }; },
      fingerprinted: async () => { log.push("fingerprinted"); return { ok: true, body: "x", status: 200 }; },
      browser: async () => { log.push("browser"); return { ok: true, body: "x", status: 200 }; },
    };
    const r = await fetchByLadder("https://x/", { impls, heavySlot: SLOT });
    /*
     * A 404 is an answer about the page. Climbing to a browser to be told 404
     * more expensively is the exact waste this ladder exists to prevent.
     */
    log.join(",") === "http" && r.servedBy === null
      ? ok("a 404 stops the walk rather than being retried more expensively")
      : bad(`a final answer was escalated past: tried ${log.join(", ")}`);
    r.attempts[0]?.reason.includes("final")
      ? ok("and the record says the answer was final")
      : bad("the record does not distinguish a final answer from a refusal");
  }

  console.log("");
  console.log("4. the browser cannot be reached without the heavy slot");
  {
    const log: Tier[] = [];
    const r = await fetchByLadder("https://x/", { impls: siteNeeding("browser", log) });
    !log.includes("browser")
      ? ok("without the slot, the browser tier is not attempted at all")
      : bad("a browser ran without the heavy slot");
    const browserAttempt = r.attempts.find((a) => a.tier === "browser");
    browserAttempt?.outcome === "unavailable" && browserAttempt.reason.includes("heavy slot")
      ? ok(`and the reason distinguishes it from the site being down: "${browserAttempt.reason}"`)
      : bad(`the browser rung was recorded as ${JSON.stringify(browserAttempt)}`);
    r.servedBy === null
      ? ok("the page is unserved, which is the honest outcome")
      : bad("something served the page without the slot");
  }

  console.log("");
  console.log("5. an unconfigured rung is skipped with a reason, not counted against the site");
  {
    const log: Tier[] = [];
    const full = siteNeeding("browser", log);
    const r = await fetchByLadder("https://x/", {
      impls: { http: full.http, browser: full.browser },
      heavySlot: SLOT,
    });
    const fp = r.attempts.find((a) => a.tier === "fingerprinted");
    fp?.outcome === "skipped" && fp.reason.includes("fingerprinting client")
      ? ok(`the undecided rung says why it was skipped: "${fp.reason}"`)
      : bad(`the missing tier was recorded as ${JSON.stringify(fp)}`);
    r.servedBy === "browser"
      ? ok("and the ladder carries on past it rather than stopping")
      : bad("a missing rung ended the walk");
  }

  console.log("");
  console.log("6. a ceiling is obeyed");
  {
    const log: Tier[] = [];
    const r = await fetchByLadder("https://x/", {
      impls: siteNeeding("browser", log), heavySlot: SLOT, ceiling: "fingerprinted",
    });
    !log.includes("browser") && r.servedBy === null
      ? ok("a scrape capped below the browser does not reach one")
      : bad(`the ceiling was ignored: tried ${log.join(", ")}`);
    r.attempts.find((a) => a.tier === "browser")?.reason.includes("ceiling")
      ? ok("and the record says why")
      : bad("the ceiling is not explained in the record");
  }

  console.log("");
  console.log("7. the plain rung tells a client rejection from a page answer");
  {
    const responses: Record<string, { status: number; body: string }> = {
      "https://ok/": { status: 200, body: "<html>hi</html>" },
      "https://blocked/": { status: 403, body: "" },
      "https://gone/": { status: 404, body: "" },
      "https://busy/": { status: 429, body: "" },
    };
    const fakeFetch = (async (url: string | URL) => {
      const r = responses[String(url)];
      return { ok: r.status < 400, status: r.status, text: async () => r.body } as Response;
    }) as unknown as typeof fetch;
    const tier = httpTier(fakeFetch);
    const got = await tier("https://ok/") as FetchOutcome;
    got.ok && got.body.includes("hi") ? ok("a 200 is served") : bad("a 200 was not served");
    const blocked = await tier("https://blocked/");
    !blocked.ok && blocked.retryable
      ? ok("a 403 is a decision about the CLIENT, so it escalates")
      : bad("a 403 did not escalate");
    const busy = await tier("https://busy/");
    !busy.ok && busy.retryable ? ok("and so is a 429") : bad("a 429 did not escalate");
    const gone = await tier("https://gone/");
    !gone.ok && !gone.retryable
      ? ok("while a 404 is a decision about the PAGE, and no client changes it")
      : bad("a 404 escalated, which buys a more expensive 404");
  }

  console.log("");
  console.log("8. the order is the policy");
  TIER_ORDER.join(",") === "http,fingerprinted,browser"
    ? ok("cheapest first, browser last")
    : bad(`the ladder order is ${TIER_ORDER.join(", ")}`);

  console.log("");
  console.log(`==== ${passes} passed, ${fails} failed ====`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : JSON.stringify(e));
  process.exit(1);
});

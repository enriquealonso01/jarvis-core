/**
 * Mode 2: the model decides HOW, and ordinary code does the work (plan S32).
 *
 *   "The agent determines *how* to scrape. Normal software performs the actual
 *    scraping."
 *
 *   "Making an LLM click through Chrome 14,000 times is the single most
 *    expensive mistake available in this system: orders of magnitude slower,
 *    costs per page, and fails in a new way each time. Mode 2 exists to make
 *    that impossible rather than merely discouraged."
 *
 * "Impossible rather than merely discouraged" is a structural claim, so the
 * structure has to carry it: `runScrape` has no way to reach a model. Not a
 * policy against it, not a check - it is not given one, so a change that made
 * scraping per-page-expensive again could not be a small one, and would have to
 * add a parameter somebody would see in review.
 *
 * THE OTHER HALF IS THE INJECTION, and it is a different risk from a poisoned
 * message rather than a smaller one:
 *
 *   "A message can talk a model into a bad reply. A page can talk a model into
 *    writing a program."
 *
 * The defence the plan names is a constrained emitter: the model's output is a
 * SPECIFICATION - url pattern, selectors, pagination rule, rate limit, output
 * shape - and never code, because "there is nowhere in a selector to put a
 * shell command". `validateSpec` is where that stops being an aspiration. It
 * does not sanitise; it REJECTS anything that is not the narrow shape, so the
 * question "did we escape it properly" never arises. A page that talks the
 * model into emitting something clever produces a spec that fails validation,
 * and the run does not start.
 */

export type PaginationRule =
  | { kind: "none" }
  /** Follow a "next" link, found by selector, up to maxPages. */
  | { kind: "link"; selector: string }
  /** Increment a query parameter: ?page=1, 2, 3… */
  | { kind: "pageParam"; param: string; start: number };

export type FieldRule = {
  name: string;
  selector: string;
  /** Which part of the matched element. Text, or one named attribute. */
  attr?: string;
};

/** Plan S32's ladder: cheapest fetch that works, escalate only on failure. */
export type FetchTier = "http" | "fingerprinted" | "browser";

export type ScrapeSpec = {
  startUrl: string;
  fields: FieldRule[];
  pagination: PaginationRule;
  /** Politeness, per domain, and not optional. */
  rateLimitMs: number;
  maxPages: number;
  tier: FetchTier;
};

/**
 * A selector, and nothing that is not one.
 *
 * Deliberately narrower than CSS. The grammar admits tags, classes, ids,
 * attribute equality, descendant and child combinators, and `:nth-of-type` -
 * which covers what extraction needs - and admits no parentheses beyond that,
 * no quotes beyond the attribute value, no semicolons, no backticks and no
 * whitespace characters other than a plain space. A selector language that can
 * express a function call is a language somebody will eventually evaluate.
 */
const SELECTOR_RE = /^[a-zA-Z0-9_\-.#[\]="' >:()]+$/;
const SELECTOR_MAX = 200;

/** Field names become keys in the output artifact, so they are identifiers. */
const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

const TIERS = new Set<FetchTier>(["http", "fingerprinted", "browser"]);

/** Politeness has a floor. A spec asking for zero delay is not honoured. */
const MIN_RATE_LIMIT_MS = 200;
const MAX_PAGES_CEILING = 50_000;

export type SpecProblem = { field: string; problem: string };

/**
 * Turn whatever the model produced into a spec, or say why it is not one.
 *
 * Returns problems rather than throwing, and returns ALL of them rather than
 * the first: a design pass that has to be re-run once per complaint costs a
 * model call per complaint, which is the thing this whole mode exists to avoid.
 */
export function validateSpec(raw: unknown): { ok: true; spec: ScrapeSpec } | { ok: false; problems: SpecProblem[] } {
  const problems: SpecProblem[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;

  const url = typeof o.startUrl === "string" ? o.startUrl : "";
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    problems.push({ field: "startUrl", problem: "not a URL" });
  }
  if (parsed && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // file: and data: are the two that turn a scrape into a local read.
    problems.push({ field: "startUrl", problem: `${parsed.protocol} is not a web page` });
  }

  const fields: FieldRule[] = [];
  const rawFields = Array.isArray(o.fields) ? o.fields : [];
  if (!rawFields.length) problems.push({ field: "fields", problem: "a scrape with no fields collects nothing" });
  for (const [n, f] of rawFields.entries()) {
    const fo = (f ?? {}) as Record<string, unknown>;
    const name = typeof fo.name === "string" ? fo.name : "";
    const selector = typeof fo.selector === "string" ? fo.selector : "";
    if (!FIELD_NAME_RE.test(name)) problems.push({ field: `fields[${n}].name`, problem: `"${name}" is not a field name` });
    if (!selector || selector.length > SELECTOR_MAX || !SELECTOR_RE.test(selector)) {
      problems.push({ field: `fields[${n}].selector`, problem: "not a selector" });
    }
    const attr = typeof fo.attr === "string" ? fo.attr : undefined;
    if (attr !== undefined && !/^[a-zA-Z][a-zA-Z0-9\-]{0,39}$/.test(attr)) {
      problems.push({ field: `fields[${n}].attr`, problem: "not an attribute name" });
    }
    // Anything the emitter did not ask for is a red flag rather than something
    // to ignore: a model that added a key is a model that was told to.
    for (const key of Object.keys(fo)) {
      if (!["name", "selector", "attr"].includes(key)) {
        problems.push({ field: `fields[${n}].${key}`, problem: "not part of a field rule" });
      }
    }
    fields.push({ name, selector, ...(attr ? { attr } : {}) });
  }

  const rawPag = (o.pagination ?? { kind: "none" }) as Record<string, unknown>;
  let pagination: PaginationRule = { kind: "none" };
  if (rawPag.kind === "none") {
    pagination = { kind: "none" };
  } else if (rawPag.kind === "link") {
    const sel = typeof rawPag.selector === "string" ? rawPag.selector : "";
    if (!sel || sel.length > SELECTOR_MAX || !SELECTOR_RE.test(sel)) {
      problems.push({ field: "pagination.selector", problem: "not a selector" });
    }
    pagination = { kind: "link", selector: sel };
  } else if (rawPag.kind === "pageParam") {
    const param = typeof rawPag.param === "string" ? rawPag.param : "";
    const start = typeof rawPag.start === "number" ? rawPag.start : 1;
    if (!/^[a-zA-Z][a-zA-Z0-9_\-]{0,29}$/.test(param)) {
      problems.push({ field: "pagination.param", problem: "not a query parameter name" });
    }
    if (!Number.isInteger(start) || start < 0) {
      problems.push({ field: "pagination.start", problem: "not a page number" });
    }
    pagination = { kind: "pageParam", param, start };
  } else {
    problems.push({ field: "pagination.kind", problem: `"${String(rawPag.kind)}" is not a pagination rule` });
  }

  const rate = typeof o.rateLimitMs === "number" ? o.rateLimitMs : NaN;
  if (!Number.isFinite(rate) || rate < MIN_RATE_LIMIT_MS) {
    problems.push({ field: "rateLimitMs", problem: `politeness has a floor of ${MIN_RATE_LIMIT_MS}ms` });
  }
  const maxPages = typeof o.maxPages === "number" ? o.maxPages : NaN;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_CEILING) {
    problems.push({ field: "maxPages", problem: "a scrape has to say when it stops" });
  }
  const tier = o.tier as FetchTier;
  if (!TIERS.has(tier)) problems.push({ field: "tier", problem: `"${String(tier)}" is not a fetch tier` });

  for (const key of Object.keys(o)) {
    if (!["startUrl", "fields", "pagination", "rateLimitMs", "maxPages", "tier"].includes(key)) {
      problems.push({ field: key, problem: "not part of a scrape specification" });
    }
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, spec: { startUrl: url, fields, pagination, rateLimitMs: rate, maxPages, tier } };
}

/**
 * The structural signature of a page, for deciding whether it is a new SHAPE.
 *
 * This is the whole economics of Mode 2. The model is asked about a page whose
 * shape it has not seen; 14,000 pages of the same shape are one question. So
 * the signature has to ignore CONTENT and keep STRUCTURE - the sequence of tag
 * names and class attributes, with text thrown away - or every page differs and
 * the mode collapses back into per-page model calls without anybody noticing.
 */
export function pageShape(html: string): string {
  const tags = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .match(/<([a-zA-Z][a-zA-Z0-9]*)((?:\s+class="[^"]*")?)/g) ?? [];
  const skeleton = tags
    .map((t) => t.replace(/\s+/g, " ").trim().toLowerCase())
    .join(">");
  let hash = 0;
  for (let i = 0; i < skeleton.length; i += 1) {
    hash = (hash * 31 + skeleton.charCodeAt(i)) | 0;
  }
  return `s${(hash >>> 0).toString(16)}`;
}

export type DesignResult = {
  spec: ScrapeSpec | null;
  problems: SpecProblem[];
  /** How many times a model was asked. The number this whole mode is about. */
  modelCalls: number;
  shapes: string[];
};

/**
 * Ask a model how to scrape this site - once per SHAPE, never per page.
 *
 * `askModel` is injected rather than imported, which is not only for testing:
 * it is the seam that lets `runScrape` be defined in the same file and still
 * have no route to a model at all.
 */
export async function designScrape(
  samples: { url: string; html: string }[],
  askModel: (sample: { url: string; html: string }) => Promise<unknown>,
): Promise<DesignResult> {
  const seen = new Set<string>();
  const shapes: string[] = [];
  let modelCalls = 0;
  let candidate: unknown = null;

  for (const sample of samples) {
    const shape = pageShape(sample.html);
    if (seen.has(shape)) continue;
    seen.add(shape);
    shapes.push(shape);
    modelCalls += 1;
    candidate = await askModel(sample);
  }

  if (candidate === null) {
    return { spec: null, problems: [{ field: "samples", problem: "nothing to look at" }], modelCalls, shapes };
  }
  const validated = validateSpec(candidate);
  return validated.ok
    ? { spec: validated.spec, problems: [], modelCalls, shapes }
    : { spec: null, problems: validated.problems, modelCalls, shapes };
}

export type ScrapeRow = Record<string, string>;

export type ScrapeRun = {
  rows: ScrapeRow[];
  pagesFetched: number;
  /** Every page it parsed, kept so a wrong result can be diagnosed without re-scraping. */
  snapshots: { url: string; html: string }[];
  stoppedBecause: string;
};

/**
 * Run the specification. No model, by construction.
 *
 * `fetchPage` is the only thing it can reach outside itself, and it returns a
 * page. There is no parameter here through which a model could be threaded, and
 * that is the point of the signature rather than an accident of it.
 */
export async function runScrape(
  spec: ScrapeSpec,
  fetchPage: (url: string) => Promise<string | null>,
  opts: { sleep?: (ms: number) => Promise<void>; allowed?: (url: string) => boolean } = {},
): Promise<ScrapeRun> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const rows: ScrapeRow[] = [];
  const snapshots: { url: string; html: string }[] = [];
  let url: string | null = spec.startUrl;
  let page = spec.pagination.kind === "pageParam" ? spec.pagination.start : 0;
  let fetched = 0;
  let stoppedBecause = "no more pages";

  while (url && fetched < spec.maxPages) {
    if (opts.allowed && !opts.allowed(url)) {
      stoppedBecause = `robots.txt disallows ${url}`;
      break;
    }
    // Before the request, not after: a limiter that sleeps afterwards still
    // sends the first burst at whatever rate the loop can manage.
    if (fetched > 0) await sleep(spec.rateLimitMs);
    const html = await fetchPage(url);
    if (html === null) {
      stoppedBecause = `no page at ${url}`;
      break;
    }
    fetched += 1;
    snapshots.push({ url, html });
    rows.push(...extract(html, spec.fields));

    if (spec.pagination.kind === "none") {
      url = null;
    } else if (spec.pagination.kind === "pageParam") {
      page += 1;
      const next = new URL(spec.startUrl);
      next.searchParams.set(spec.pagination.param, String(page));
      url = next.toString();
    } else {
      url = nextLink(html, spec.pagination.selector, url);
      if (!url) stoppedBecause = "no next link";
    }
  }
  if (fetched >= spec.maxPages) stoppedBecause = `reached maxPages (${spec.maxPages})`;
  return { rows, pagesFetched: fetched, snapshots, stoppedBecause };
}

/*
 * A deliberately small extractor.
 *
 * It supports the subset the spec grammar admits - a tag, a class, or a tag
 * with a class - rather than pulling in a full CSS engine. That is a real
 * limitation and it is written down rather than discovered: a site needing more
 * than this needs the browser tier, and the honest failure is "no rows" rather
 * than a selector language that quietly means something else than it says.
 */
function extract(html: string, fields: FieldRule[]): ScrapeRow[] {
  const perField = fields.map((f) => matchAll(html, f));
  const n = Math.max(0, ...perField.map((v) => v.length));
  const rows: ScrapeRow[] = [];
  for (let i = 0; i < n; i += 1) {
    const row: ScrapeRow = {};
    fields.forEach((f, fi) => { row[f.name] = perField[fi][i] ?? ""; });
    rows.push(row);
  }
  return rows;
}

function matchAll(html: string, field: FieldRule): string[] {
  const sel = field.selector.trim();
  const m = /^([a-zA-Z][a-zA-Z0-9]*)?(?:\.([a-zA-Z0-9_-]+))?$/.exec(sel);
  if (!m) return [];
  const [, tag, cls] = m;
  const tagPart = tag ?? "[a-zA-Z][a-zA-Z0-9]*";
  const re = new RegExp(
    `<(${tagPart})([^>]*)>([\\s\\S]*?)</\\1>`,
    "g",
  );
  const out: string[] = [];
  for (const hit of html.matchAll(re)) {
    const attrs = hit[2] ?? "";
    if (cls && !new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"`).test(attrs)) continue;
    if (field.attr) {
      const a = new RegExp(`${field.attr}="([^"]*)"`).exec(attrs);
      out.push(a ? a[1] : "");
    } else {
      out.push(hit[3].replace(/<[^>]*>/g, "").trim());
    }
  }
  return out;
}

function nextLink(html: string, selector: string, base: string): string | null {
  const cls = /\.([a-zA-Z0-9_-]+)$/.exec(selector)?.[1];
  for (const hit of html.matchAll(/<a([^>]*)>/g)) {
    const attrs = hit[1] ?? "";
    if (cls && !new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"`).test(attrs)) continue;
    const href = /href="([^"]*)"/.exec(attrs)?.[1];
    if (href) return new URL(href, base).toString();
  }
  return null;
}

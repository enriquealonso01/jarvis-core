/**
 * The Composio adapter (plan S31, BLOCKERS B7).
 *
 * S31's warning is that "two adapters are not an interface", and that Composio
 * is the one that would shape the seam around itself if it were built first. So
 * it was built last, deliberately, and this file gets to be small: it declares
 * what a connection can do and performs one action. Authorising, the
 * always-confirm gate, tool classification, credential resolution, the timeout
 * and the audit record all happen ABOVE it, once, for every kind. Nothing in
 * here reads the credential store — the key arrives already resolved, which is
 * what a credential broker is for.
 *
 * TWO THINGS ARE SPECIFIC TO COMPOSIO AND BOTH ARE FAILURE-SHAPED.
 *
 * FIRST: **Composio answers HTTP 200 when the tool it ran failed.** The
 * envelope carries `successful: false` and an error beside it, and the status
 * line says nothing about either. Every other adapter here can lean on the
 * status code — `apiAdapter` throws on a non-2xx precisely so that "the body of
 * a 500" is never handed back as an answer — and that check, applied here, is
 * exactly wrong: it passes. So the envelope is what decides, and a body that
 * does not carry the envelope at all is a failure rather than a value, because
 * the alternative is handing back something whose success nobody established.
 *
 * SECOND: **the key is Composio's, so the host must be Composio's.** Every other
 * connection's `base_url` and credential belong to the same third party, and
 * pointing one at a different host is a strange thing to do with your own key.
 * Here the credential is a single account key that reaches every tool Enrique
 * has connected — GitHub, mail, calendar — and `connections.config` is data. A
 * config row naming another host would send that key to it, in a header, on the
 * first invocation. So the host is checked against a closed set rather than
 * trusted, for the same reason and in the same shape as the sandbox networks.
 */
import type { ConnectionRow, ConnectorAdapter, Invocation } from "./connectors.js";

/**
 * Hosts this adapter will send a Composio key to.
 *
 * A closed set, not a prefix test: `backend.composio.dev.evil.test` starts with
 * the right characters and is not Composio, and hostname comparison is the only
 * form of this check that is not quietly defeatable.
 */
export const COMPOSIO_HOSTS = ["backend.composio.dev", "api.composio.dev"] as const;

export const COMPOSIO_DEFAULT_BASE = "https://backend.composio.dev";

/** Composio's own envelope, as far as this adapter needs to read it. */
type Envelope = {
  successful?: unknown;
  successfull?: unknown;
  data?: unknown;
  error?: unknown;
};

export function composioBase(conn: ConnectionRow): URL {
  const raw = typeof conn.config.base_url === "string" && conn.config.base_url
    ? conn.config.base_url
    : COMPOSIO_DEFAULT_BASE;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`this composio connection has an unreadable base_url: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:") {
    throw new Error("a composio base_url must be https: the account key travels in a header");
  }
  if (!(COMPOSIO_HOSTS as readonly string[]).includes(url.hostname)) {
    throw new Error(
      `refusing to send the Composio account key to ${url.hostname}; `
      + `only ${COMPOSIO_HOSTS.join(" or ")} are allowed`,
    );
  }
  return url;
}

/**
 * Did the tool actually work?
 *
 * Read from the envelope and nowhere else. `successful` is spelled `successfull`
 * in parts of Composio's own surface and both spellings appear in the wild, so
 * both are read — and ABSENCE IS NOT SUCCESS. A response with neither field is a
 * response whose success nobody established, and defaulting that to true is how
 * "the supplier says your order shipped" gets built on top of an error.
 */
export function succeeded(envelope: Envelope): boolean {
  const flag = envelope.successful ?? envelope.successfull;
  return flag === true;
}

/** What went wrong, in the words the provider used, for the audit record. */
function whyItFailed(envelope: Envelope): string {
  const err = envelope.error;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object") return JSON.stringify(err);
  return "the provider reported no reason";
}

export function composioAdapter(doFetch: typeof fetch = fetch): ConnectorAdapter {
  return {
    kind: "composio",

    /**
     * What this connection could do.
     *
     * Read from the connection's config rather than fetched, because `declare`
     * feeds tool classification and the console, and a list that changes under
     * a network call would mean a tool's manifest changes without anybody
     * editing anything — which is exactly what S31 pins classifications against.
     */
    async declare(conn: ConnectionRow): Promise<string[]> {
      const actions = conn.config.actions;
      if (!Array.isArray(actions)) return [];
      return actions.filter((a): a is string => typeof a === "string").sort();
    },

    async invoke(conn: ConnectionRow, inv: Invocation): Promise<unknown> {
      const declared = await this.declare(conn);
      /*
       * An allow-list, like the api adapter's operations. A connector that will
       * execute any action name it is handed is a connector whose blast radius
       * is "everything Enrique ever connected to Composio", and the classifier
       * above only ever saw the declared ones.
       */
      if (!declared.includes(inv.action)) {
        throw new Error(`this composio connection declares no action called ${inv.action}`);
      }

      const accountId = conn.config.connected_account_id;
      if (typeof accountId !== "string" || !accountId) {
        throw new Error("this composio connection names no connected_account_id");
      }

      const key = inv.secret?.api_key ?? inv.secret?.composio_api_key
        ?? (inv.secret ? Object.values(inv.secret)[0] : undefined);
      if (!key) throw new Error("no Composio api key was resolved for this connection");

      const base = composioBase(conn);
      const url = new URL(
        `/api/v2/actions/${encodeURIComponent(inv.action)}/execute`,
        base,
      );

      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: {
            "x-api-key": key,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            connectedAccountId: accountId,
            input: inv.input ?? {},
          }),
        });
      } catch (err) {
        throw new Error(`could not reach Composio: ${err instanceof Error ? err.message : String(err)}`);
      }

      const text = await res.text();
      /*
       * The status still matters for the transport - a 401 is a credential
       * problem and a 502 is Composio being down, and neither carries an
       * envelope worth reading.
       */
      if (!res.ok) throw new Error(`${inv.action} returned HTTP ${res.status}`);

      let envelope: Envelope;
      try {
        envelope = JSON.parse(text) as Envelope;
      } catch {
        throw new Error(`${inv.action} returned a body that is not JSON`);
      }
      if (!envelope || typeof envelope !== "object") {
        throw new Error(`${inv.action} returned no envelope`);
      }

      /*
       * THE RULE THIS FILE EXISTS FOR. A 200 whose envelope says the tool failed
       * is a failure, and it has to raise here - the layer above records the
       * outcome of what this returns, so a failure returned as a value is
       * audited as a success and reported to him as one.
       */
      if (!succeeded(envelope)) {
        throw new Error(`${inv.action} failed at the provider: ${whyItFailed(envelope)}`);
      }
      return envelope.data;
    },
  };
}

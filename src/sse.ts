import type { FastifyReply } from "fastify";

type EventName =
  | "health"
  | "task.updated"
  | "queue.updated"
  | "issue.updated"
  | "approval.updated"
  | "conversation.message"
  | "heartbeat";

const clients = new Set<FastifyReply>();

export function sseAdd(reply: FastifyReply) {
  clients.add(reply);
  reply.raw.on("close", () => clients.delete(reply));
}

/**
 * Where a broadcast goes when it has to leave this process.
 *
 * Set by startSseBridge; null in a process with no database handle yet, so a
 * broadcast during boot degrades to local-only rather than throwing.
 */
let forward: ((type: EventName, data: unknown) => void) | null = null;

export function setSseForwarder(fn: ((type: EventName, data: unknown) => void) | null): void {
  forward = fn;
}

/** Write to the browsers connected to THIS process, and nobody else. */
export function sseDeliverLocal(type: EventName, data: unknown): void {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const reply of clients) {
    try {
      reply.raw.write(payload);
    } catch {
      clients.delete(reply);
    }
  }
}

/**
 * Tell every connected console about something that happened.
 *
 * The browsers are connected to the API process. The runner and the worker are
 * different processes — different containers on the dev stack, a systemd unit
 * beside a container in production — so every broadcast the RUNNER made was
 * written into an empty set of clients and vanished. The console had live
 * updates for everything the API did to a task and nothing at all for what the
 * runner did to it, which is to say nothing worth watching. It looked like it
 * worked because opening the page fetches the current state, and the current
 * state is usually recent.
 *
 * So a broadcast now leaves the process through Postgres, and the API relays
 * what arrives to its own clients.
 */
export function sseBroadcast(type: EventName, data: unknown) {
  sseDeliverLocal(type, data);
  forward?.(type, data);
}

export function sseHeartbeat() {
  sseBroadcast("heartbeat", { at: new Date().toISOString() });
}

/**
 * Carry broadcasts between processes over Postgres LISTEN/NOTIFY.
 *
 * Postgres rather than Redis or a socket because it is already here, already a
 * dependency, and already the thing every process holds a connection to. One
 * more moving part to make a progress bar move would be a bad trade.
 *
 * A dedicated client, not a pool connection: LISTEN is a property of a session,
 * and a pooled connection is handed back after the query, taking the
 * subscription with it.
 *
 * `listen` is true only in the API — it is the process browsers connect to.
 * Everyone else forwards and never receives, so a notification cannot loop.
 */
/** Stop a client's socket from holding the process open. */
function unref(client: import("pg").Client): void {
  const stream = (client as unknown as { connection?: { stream?: { unref?: () => void } } })
    .connection?.stream;
  stream?.unref?.();
}

export async function startSseBridge(
  connectionString: () => Promise<import("pg").Client>,
  opts: { listen: boolean },
): Promise<void> {
  const CHANNEL = "jarvis_sse";

  const notifier = await connectionString();
  // A live pg.Client keeps the Node event loop open forever. The runner's
  // `RUNNER_ONCE` mode finished its task, returned from main(), and then simply
  // never exited — twelve one-shot containers were still up half an hour later
  // and every suite that waits for one hung. Unref the socket: the connection
  // stays usable, it just stops being a reason for the process to live.
  unref(notifier);
  setSseForwarder((type, data) => {
    // Fire and forget. A console that misses a redraw is a smaller problem than
    // a runner that stalls because a notification could not be delivered, and
    // the page refetches on reconnect anyway.
    void notifier
      .query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify({ type, data })])
      .catch(() => undefined);
  });

  if (!opts.listen) return;

  const listener = await connectionString();
  unref(listener);
  listener.on("notification", (msg) => {
    if (msg.channel !== CHANNEL || !msg.payload) return;
    try {
      const parsed = JSON.parse(msg.payload) as { type: EventName; data: unknown };
      // Local only. Relaying this back out would be an infinite loop.
      sseDeliverLocal(parsed.type, parsed.data);
    } catch {
      /* a malformed notification is not worth taking the API down for */
    }
  });
  listener.on("error", () => {
    /* the reconnect below handles it */
  });
  await listener.query(`LISTEN ${CHANNEL}`);
}

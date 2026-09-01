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

export function sseBroadcast(type: EventName, data: unknown) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const reply of clients) {
    try {
      reply.raw.write(payload);
    } catch {
      clients.delete(reply);
    }
  }
}

export function sseHeartbeat() {
  sseBroadcast("heartbeat", { at: new Date().toISOString() });
}

/**
 * A generic MCP client, and the box its server runs in (plan S31).
 *
 * "Untrusted servers run in Docker, never on the host." That sentence is the
 * whole security design of this file, and everything else is protocol.
 *
 * The threat is not the usual one. An MCP server is not a library Jarvis calls;
 * it is somebody else's program, holding its own credentials, making its own
 * outbound calls, and the broker that gates Jarvis's typed calls never sees any
 * of it. So the boundary has to be the process boundary, and it has to be
 * closed by the launcher rather than by anything the server cooperates with.
 *
 * `sandboxArgv` is deliberately a PURE FUNCTION returning an argv. Every
 * hardening flag is therefore assertable without Docker, by a test that reads
 * the array - which matters because the failure mode for a sandbox is that one
 * flag quietly stops being passed and nothing looks different until somebody
 * goes looking. A launcher that builds its command inline is a launcher whose
 * hardening can only be checked by escaping it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type SandboxOptions = {
  image: string;
  /** The server's own command inside the container. */
  command: string[];
  /**
   * One project's directory, mounted read-only at /project.
   *
   * ONE. "An MCP server attached to one project and invisible to another" is
   * not a policy check somewhere above this - it is that the container is never
   * given a second project's path to read.
   */
  projectDir?: string | null;
  /**
   * Default "none". Most MCP servers want the network and many need it, but the
   * default belongs on the safe side: a server that turns out to need egress
   * gets it deliberately, per connection, and that decision is recorded. The
   * reverse default means every server that never needed it had it anyway.
   */
  network?: string;
  memory?: string;
  pidsLimit?: number;
};

/**
 * The argv for one sandboxed server.
 *
 * Notably absent: any environment passthrough. A container that inherits the
 * runner's environment inherits DATABASE_URL and the master key path, and an
 * MCP server that can read those does not need to escape anything.
 */
export function sandboxArgv(opts: SandboxOptions): string[] {
  const argv = [
    "run", "--rm", "--interactive",
    // No TTY: this is a pipe, and a TTY would line-edit the JSON going through it.
    "--network", opts.network ?? "none",
    // The filesystem the image ships with, and nothing else writable.
    "--read-only",
    // A read-only rootfs still needs scratch space, and it must not be a place
    // to stage an executable.
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop", "ALL",
    // Blocks setuid binaries inside the image from regaining what --cap-drop took.
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(opts.pidsLimit ?? 128),
    "--memory", opts.memory ?? "512m",
    // Never root, even inside a container: a root process on a mounted volume
    // writes files the host user cannot then manage.
    "--user", "1000:1000",
  ];
  if (opts.projectDir) argv.push("--volume", `${opts.projectDir}:/project:ro`);
  argv.push(opts.image, ...opts.command);
  return argv;
}

type RpcResponse = {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
};

export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

/**
 * One conversation with one server, over its stdin and stdout.
 *
 * MCP frames JSON-RPC as newline-delimited JSON. The framing is the part that
 * looks trivial and is not: stdout arrives in whatever chunks the pipe decides,
 * so a message can be split across two reads and two messages can arrive in
 * one. Buffering until a newline is what makes this correct rather than
 * usually-correct, and "usually" here means it works locally and corrupts under
 * load.
 */
export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private stderr = "";

  constructor(private readonly launch: { command: string; args: string[] }) {}

  start(): void {
    const child = spawn(this.launch.command, this.launch.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    // Kept, not printed. A server's stderr is its own words, and it is useful
    // when a call fails - but it goes in an error message, never into a log
    // line that reads as something Jarvis said.
    child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    child.on("exit", () => {
      for (const [, p] of this.pending) {
        p.reject(new Error(`the server exited${this.stderr ? `: ${this.stderr.trim().slice(0, 200)}` : ""}`));
      }
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onMessage(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private onMessage(line: string): void {
    let msg: RpcResponse;
    try {
      msg = JSON.parse(line) as RpcResponse;
    } catch {
      // A server that writes something other than JSON to stdout is broken, and
      // guessing at what it meant is how a parser becomes an attack surface.
      return;
    }
    if (typeof msg.id !== "number") return;
    const waiting = this.pending.get(msg.id);
    if (!waiting) return;
    this.pending.delete(msg.id);
    if (msg.error) waiting.reject(new Error(msg.error.message));
    else waiting.resolve(msg.result);
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("the server was never started"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async initialize(): Promise<unknown> {
    return this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "jarvis", version: "1" },
    });
  }

  async listTools(): Promise<McpTool[]> {
    const r = await this.request("tools/list") as { tools?: McpTool[] };
    return r?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  stop(): void {
    this.child?.stdin.end();
    this.child?.kill("SIGKILL");
    this.child = null;
  }
}

/**
 * One call, one container.
 *
 * A long-lived server would be cheaper, and it is the wrong trade here: a
 * container that outlives the call it was started for is a process holding a
 * mounted project directory for as long as nobody notices. Starting one per
 * call costs a container start and buys a boundary that closes by itself.
 */
export async function callSandboxedTool(args: {
  image: string;
  command: string[];
  projectDir?: string | null;
  network?: string;
  tool: string;
  input: Record<string, unknown>;
}): Promise<unknown> {
  const client = new McpClient({
    command: "docker",
    args: sandboxArgv({
      image: args.image, command: args.command,
      projectDir: args.projectDir, network: args.network,
    }),
  });
  client.start();
  try {
    await client.initialize();
    return await client.callTool(args.tool, args.input);
  } finally {
    client.stop();
  }
}

export async function listSandboxedTools(args: {
  image: string;
  command: string[];
  projectDir?: string | null;
  network?: string;
}): Promise<McpTool[]> {
  const client = new McpClient({
    command: "docker",
    args: sandboxArgv(args),
  });
  client.start();
  try {
    await client.initialize();
    return await client.listTools();
  } finally {
    client.stop();
  }
}

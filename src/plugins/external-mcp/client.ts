import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type ExternalMcpServerSpec = {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
};

type ExternalMcpSession = {
  key: string;
  client: Client;
  transport: StdioClientTransport;
  stderr: string[];
};

function normalizedEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...getDefaultEnvironment(), ...(extra ?? {}) };
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function specKey(spec: ExternalMcpServerSpec): string {
  return createHash("sha256")
    .update(JSON.stringify({ command: spec.command, args: spec.args ?? [], cwd: spec.cwd ?? null, env: spec.env ?? {} }))
    .digest("hex");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ExternalMcpClientManager {
  private readonly sessions = new Map<string, ExternalMcpSession>();
  private readonly connecting = new Map<string, Promise<ExternalMcpSession>>();

  async connect(spec: ExternalMcpServerSpec): Promise<ExternalMcpSession> {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(spec.id)) throw new Error(`Invalid external MCP id: ${spec.id}`);
    if (!spec.command.trim()) throw new Error("External MCP command is required");

    const key = specKey(spec);
    const current = this.sessions.get(spec.id);
    if (current?.key === key) return current;
    if (current) await this.close(spec.id);

    const pending = this.connecting.get(spec.id);
    if (pending) return pending;

    const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? 15_000, 1_000), 120_000);
    const promise = (async () => {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args ?? [],
        cwd: spec.cwd,
        env: normalizedEnv(spec.env),
        stderr: "pipe",
      });
      const stderr: string[] = [];
      transport.stderr?.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (!text) return;
        stderr.push(text.slice(0, 4_000));
        if (stderr.length > 20) stderr.shift();
      });
      const client = new Client({ name: `jk-${spec.id}`, version: "1.0.0" });
      try {
        await withTimeout(client.connect(transport), timeoutMs, `External MCP ${spec.id} initialize`);
      } catch (error) {
        await transport.close().catch(() => undefined);
        const detail = stderr.length ? `\n${stderr.join("\n").slice(-8_000)}` : "";
        throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
      }
      const session = { key, client, transport, stderr };
      this.sessions.set(spec.id, session);
      return session;
    })();

    this.connecting.set(spec.id, promise);
    try {
      return await promise;
    } finally {
      this.connecting.delete(spec.id);
    }
  }

  status(id: string): { connected: boolean; pid: number | null; server?: { name: string; version: string }; stderr: string[] } {
    const session = this.sessions.get(id);
    const server = session?.client.getServerVersion();
    return {
      connected: Boolean(session),
      pid: session?.transport.pid ?? null,
      server: server ? { name: server.name, version: server.version } : undefined,
      stderr: session?.stderr.slice(-5) ?? [],
    };
  }

  async listTools(spec: ExternalMcpServerSpec): Promise<Awaited<ReturnType<Client["listTools"]>>["tools"]> {
    const session = await this.connect(spec);
    const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? 15_000, 1_000), 120_000);
    const result = await withTimeout(session.client.listTools(), timeoutMs, `External MCP ${spec.id} tools/list`);
    return result.tools;
  }

  async callTool(spec: ExternalMcpServerSpec, toolName: string, args: Record<string, unknown> = {}) {
    if (!toolName.trim()) throw new Error("External MCP tool name is required");
    const session = await this.connect(spec);
    const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? 30_000, 1_000), 300_000);
    const tools = await withTimeout(session.client.listTools(), timeoutMs, `External MCP ${spec.id} tools/list`);
    if (!tools.tools.some((tool) => tool.name === toolName)) throw new Error(`External MCP ${spec.id} does not expose tool ${toolName}`);
    return withTimeout(
      session.client.callTool({ name: toolName, arguments: args }),
      timeoutMs,
      `External MCP ${spec.id} tool ${toolName}`,
    );
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (!session) return;
    await session.transport.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}

export const externalMcpClients = new ExternalMcpClientManager();

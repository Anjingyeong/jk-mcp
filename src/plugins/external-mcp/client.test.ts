import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExternalMcpClientManager } from "./client.js";

describe("ExternalMcpClientManager", () => {
  const manager = new ExternalMcpClientManager();
  const spec = {
    id: "fixture",
    command: process.execPath,
    args: [path.resolve("src/plugins/external-mcp/fixtures/echo-server.mjs")],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  };

  afterEach(async () => {
    await manager.closeAll();
  });

  it("connects over stdio, lists tools, and calls only advertised tools", async () => {
    const tools = await manager.listTools(spec);
    expect(tools.map((tool) => tool.name)).toContain("echo");
    expect(manager.status("fixture").connected).toBe(true);
    expect(manager.status("fixture").pid).toEqual(expect.any(Number));

    const result = await manager.callTool(spec, "echo", { message: "hello" });
    expect("content" in result && result.content).toEqual(expect.arrayContaining([{ type: "text", text: "hello" }]));
    await expect(manager.callTool(spec, "missing", {})).rejects.toThrow(/does not expose tool missing/u);
  });

  it("rejects invalid server ids before spawning", async () => {
    await expect(manager.connect({ ...spec, id: "../bad" })).rejects.toThrow(/Invalid external MCP id/u);
  });
});

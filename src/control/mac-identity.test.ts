import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exists: vi.fn(), spawn: vi.fn() }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: mocks.exists }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn }));
const platform = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform);
  vi.resetModules();
  vi.clearAllMocks();
});

describe("bundled macOS helper identity", () => {
  it.each([
    { available: ["jk-ax"], selected: "jk-ax" },
    { available: ["jk-ax", "chatgpt2codex-ax"], selected: "jk-ax" },
    { available: ["chatgpt2codex-ax"], selected: "chatgpt2codex-ax" },
  ])("selects $selected from $available without launching desktop control", async ({ available, selected }) => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    mocks.exists.mockImplementation((candidate: string) => available.includes(path.basename(candidate)));
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify({ accessibilityTrusted: true, screenRecordingAllowed: true }));
        child.emit("close", 0);
      });
      return child;
    });
    const { preflightPermissions } = await import("./mac-input.js");
    await preflightPermissions();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(path.basename(mocks.spawn.mock.calls[0]?.[0])).toBe(selected);
  });
});

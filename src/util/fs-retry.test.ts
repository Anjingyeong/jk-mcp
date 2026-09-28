import { afterEach, describe, expect, it, vi } from "vitest";

const renameMock = vi.fn<(from: string, to: string) => Promise<void>>();
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: (from: string, to: string) => renameMock(from, to) };
});

const { renameWithRetry } = await import("./fs-retry.js");

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

afterEach(() => renameMock.mockReset());

describe("renameWithRetry", () => {
  it("retries transient Windows sharing violations and then succeeds", async () => {
    renameMock
      .mockRejectedValueOnce(errno("EPERM"))
      .mockRejectedValueOnce(errno("EBUSY"))
      .mockRejectedValueOnce(errno("EACCES"))
      .mockResolvedValueOnce(undefined);
    await renameWithRetry("a", "b", { baseDelayMs: 0 });
    expect(renameMock).toHaveBeenCalledTimes(4);
  });

  it("rethrows non-transient errors immediately", async () => {
    renameMock.mockRejectedValueOnce(errno("ENOENT"));
    await expect(renameWithRetry("a", "b", { baseDelayMs: 0 })).rejects.toMatchObject({ code: "ENOENT" });
    expect(renameMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured attempts", async () => {
    renameMock.mockRejectedValue(errno("EPERM"));
    await expect(renameWithRetry("a", "b", { attempts: 3, baseDelayMs: 0 })).rejects.toMatchObject({ code: "EPERM" });
    expect(renameMock).toHaveBeenCalledTimes(3);
  });
});

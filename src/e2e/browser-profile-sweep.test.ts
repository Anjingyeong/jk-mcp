import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepOrphanBrowserProfiles } from "./local-e2e.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jk-profile-sweep-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("sweepOrphanBrowserProfiles", () => {
  it("removes only stale browser-profile dirs and leaves fresh or unrelated entries", async () => {
    const now = 2_000_000_000_000;
    const stale = `browser-profile-${now - 60 * 60 * 1000}-abc123`;
    const fresh = `browser-profile-${now - 60 * 1000}-def456`;
    await fs.mkdir(path.join(dir, stale, "Default"), { recursive: true });
    await fs.mkdir(path.join(dir, fresh));
    await fs.mkdir(path.join(dir, "screenshots"));
    await fs.writeFile(path.join(dir, "e2e-run.log"), "log");

    expect(await sweepOrphanBrowserProfiles(dir, now)).toBe(1);
    expect((await fs.readdir(dir)).sort()).toEqual([fresh, "e2e-run.log", "screenshots"].sort());
  });

  it("returns 0 for a missing directory", async () => {
    expect(await sweepOrphanBrowserProfiles(path.join(dir, "missing"))).toBe(0);
  });
});

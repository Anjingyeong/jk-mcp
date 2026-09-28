import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "./ledger.js";

describe("Ledger", () => {
  let dir: string;
  let ledger: Ledger;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatgpt2codex-ledger-"));
    ledger = new Ledger(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates audit.jsonl on first append", async () => {
    await ledger.append({ type: "workspace.opened" });
    const content = await readFile(join(dir, "audit.jsonl"), "utf8");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("appends accumulate as one JSON object per line, never rewriting prior lines", async () => {
    await ledger.append({ type: "workspace.opened" });
    await ledger.append({ type: "project.selected", projectId: "alpha-app" });
    await ledger.append({ type: "tool.call.requested", tool: "code_search" });

    const content = await readFile(join(dir, "audit.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]?.type).toBe("workspace.opened");
    expect(parsed[1]?.type).toBe("project.selected");
    expect(parsed[1]?.projectId).toBe("alpha-app");
    expect(parsed[2]?.type).toBe("tool.call.requested");
  });

  it("stamps every event with an integer epoch-ms ts, ignoring caller-supplied ts", async () => {
    await ledger.append({ type: "policy.decision", ts: "not-a-number" });
    const content = await readFile(join(dir, "audit.jsonl"), "utf8");
    const record = JSON.parse(content.trim());
    expect(Number.isInteger(record.ts)).toBe(true);
    expect(record.ts).toBeGreaterThan(1000);
  });

  it("preserves insertion order across many sequential appends", async () => {
    for (let i = 0; i < 25; i++) {
      await ledger.append({ type: "fs.mutation.staged", seq: i });
    }
    const content = await readFile(join(dir, "audit.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(25);
    const seqs = lines.map((l) => JSON.parse(l).seq);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it("rejects events without a type", async () => {
    // @ts-expect-error intentionally malformed input for boundary testing
    await expect(ledger.append({})).rejects.toThrow();
  });

  it("creates the ledger directory and file with restrictive permissions", async () => {
    if (process.platform === "win32") return;
    await ledger.append({ type: "workspace.opened" });
    const dirStat = await stat(dir);
    const fileStat = await stat(join(dir, "audit.jsonl"));
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  describe("rotation", () => {
    const rotatedFiles = async () => (await readdir(dir)).filter((n) => /^audit\.\d{13}(-\d+)?\.jsonl$/.test(n));

    it("renames the active file aside once maxBytes is reached, losing no events", async () => {
      const small = new Ledger(dir, { maxBytes: 400, keep: 100 });
      for (let i = 0; i < 20; i++) await small.append({ type: "tool.call", seq: i });
      const rotated = await rotatedFiles();
      expect(rotated.length).toBeGreaterThan(0);
      const all: number[] = [];
      for (const name of [...rotated, "audit.jsonl"]) {
        const text = await readFile(join(dir, name), "utf8");
        for (const line of text.split("\n").filter(Boolean)) all.push(JSON.parse(line).seq);
      }
      expect(all.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect((await stat(join(dir, "audit.jsonl"))).size).toBeLessThan(400 + 200);
    });

    it("keeps only the newest N rotated files", async () => {
      const small = new Ledger(dir, { maxBytes: 100, keep: 2 });
      for (let i = 0; i < 30; i++) await small.append({ type: "tool.call", seq: i, pad: "x".repeat(40) });
      expect((await rotatedFiles()).length).toBe(2);
      const newest = await readFile(join(dir, "audit.jsonl"), "utf8").catch(() => "");
      const lastSeqs = newest.split("\n").filter(Boolean).map((l) => JSON.parse(l).seq);
      // The very last event is never pruned.
      const rotatedText = await Promise.all((await rotatedFiles()).map((n) => readFile(join(dir, n), "utf8")));
      const seqs = [...lastSeqs, ...rotatedText.flatMap((t) => t.split("\n").filter(Boolean).map((l) => JSON.parse(l).seq))];
      expect(seqs).toContain(29);
    });

    it("maxBytes=0 disables rotation", async () => {
      const off = new Ledger(dir, { maxBytes: 0 });
      for (let i = 0; i < 20; i++) await off.append({ type: "tool.call", seq: i, pad: "x".repeat(100) });
      expect(await rotatedFiles()).toEqual([]);
    });

    it("rotates an oversized pre-existing file on the next append", async () => {
      await writeFile(join(dir, "audit.jsonl"), `${JSON.stringify({ type: "old", pad: "y".repeat(500) })}\n`);
      const small = new Ledger(dir, { maxBytes: 300, keep: 5 });
      await small.append({ type: "new" });
      expect((await rotatedFiles()).length).toBe(1);
      await small.append({ type: "after" });
      const active = await readFile(join(dir, "audit.jsonl"), "utf8");
      expect(active).toContain('"after"');
      expect(active).not.toContain('"old"');
    });
  });
});

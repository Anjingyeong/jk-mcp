import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProjectMemoryStore,
  contextPackCacheKey,
  fingerprintFiles,
  resultCacheKey,
} from "./project-memory.js";

describe("ProjectMemoryStore", () => {
  let stateDir: string;
  let projectRoot: string;
  let store: ProjectMemoryStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "chatgpt2codex-memory-state-"));
    projectRoot = await mkdtemp(join(tmpdir(), "chatgpt2codex-memory-project-"));
    store = new ProjectMemoryStore(stateDir);
  });

  afterEach(async () => {
    await Promise.all([
      rm(stateDir, { recursive: true, force: true }),
      rm(projectRoot, { recursive: true, force: true }),
    ]);
  });

  it("reuses a context pack only for the same file fingerprint", async () => {
    await writeFile(join(projectRoot, "a.ts"), "export const value = 1;\n", "utf8");
    const files = ["a.ts"];
    const fingerprint = await fingerprintFiles(projectRoot, files);
    const key = contextPackCacheKey("value", files, 20_000);

    await store.putContextPack("alpha", {
      key,
      fingerprint,
      topic: "value",
      bundle: "cached bundle",
      files: [{ path: "a.ts", reason: "matched" }],
      truncated: false,
      bytesUsed: 13,
    });

    expect(await store.getContextPack("alpha", key, fingerprint)).toMatchObject({ bundle: "cached bundle" });

    await writeFile(join(projectRoot, "a.ts"), "export const value = 123456;\n", "utf8");
    const changedFingerprint = await fingerprintFiles(projectRoot, files);
    expect(changedFingerprint).not.toBe(fingerprint);
    expect(await store.getContextPack("alpha", key, changedFingerprint)).toBeNull();
  });

  it("round-trips analysis results by task/role/fingerprint key", async () => {
    const fingerprint = "fp-1";
    const key = resultCacheKey("security review", "reviewer", fingerprint);
    await store.putResult("alpha", {
      key,
      task: "security review",
      role: "reviewer",
      fingerprint,
      value: "No critical findings.",
    });

    expect(await store.getResult("alpha", key)).toMatchObject({ value: "No critical findings.", fingerprint });
    expect(await store.getResult("alpha", resultCacheKey("security review", "reviewer", "fp-2"))).toBeNull();
  });

  it("deduplicates known fixes and ranks matching symptoms", async () => {
    const first = await store.addKnownFix("alpha", {
      title: "Player ready race",
      symptom: "mobile player stays black after opening a video",
      solution: "wait for player ready before issuing play",
      tags: ["player", "mobile"],
      files: ["src/player.ts"],
    });
    const updated = await store.addKnownFix("alpha", {
      title: "Player ready race",
      symptom: "mobile player stays black after opening a video",
      solution: "gate play behind the ready event",
      tags: ["player", "ready"],
      files: ["src/player.ts"],
    });

    expect(updated.id).toBe(first.id);
    const matches = await store.searchKnownFixes("alpha", "black player ready", 5);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ id: first.id, solution: "gate play behind the ready event" });
    expect(matches[0]?.score).toBeGreaterThan(0);
  });

  it("counts repeated project feedback and selects only recurring, relevant items", async () => {
    await store.recordFeedback("p", { text: "UI too bright", tags: ["ui", "color"] });
    const second = await store.recordFeedback("p", { text: "UI is still too bright", key: "ui too bright" });
    expect(second).toMatchObject({ key: "ui too bright", count: 2, tags: ["ui", "color"], text: "UI is still too bright" });
    await store.recordFeedback("p", { text: "Map feels empty", key: "map empty" });
    await store.recordFeedback("p", { text: "Map feels empty", key: "map empty" });
    await store.recordFeedback("p", { text: "Once only: font too small" });
    await store.recordFeedback("other", { text: "UI too bright" });

    const ui = await store.selectRelevantFeedback("p", "Polish inventory UI colors");
    expect(ui.map((item) => item.key)).toEqual(["ui too bright"]);
    // Recurring but unrelated items need a stronger recurrence to appear without a relevance signal.
    expect(await store.selectRelevantFeedback("p", "unrelated backend refactor")).toEqual([]);
    await store.recordFeedback("p", { text: "Map feels empty", key: "map empty" });
    expect((await store.selectRelevantFeedback("p", "unrelated backend refactor")).map((item) => item.key)).toEqual(["map empty"]);
    expect((await store.listFeedback("other"))[0]?.count).toBe(1);
  });

  it("reads project memory written before feedback existed", async () => {
    await writeFile(join(stateDir, "project-memory.json"), JSON.stringify({ version: 1, updatedAt: 1, projects: { p: { contextPacks: [], results: [], knownFixes: [] } } }), "utf8");
    expect(await store.listFeedback("p")).toEqual([]);
    await store.recordFeedback("p", { text: "no PASS before Play QA" });
    expect(await store.listFeedback("p")).toHaveLength(1);
  });
});

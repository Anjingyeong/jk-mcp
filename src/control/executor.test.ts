import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../types.js";
import { approveAction, enqueue, getAction, setKill } from "./queue.js";
import { clearAuto, readAuto, setAuto } from "./auto.js";

vi.mock("./mac-input.js", () => ({
  resolveFrontmostApp: vi.fn(async () => "TextEdit"),
  clickAtPoint: vi.fn(async () => undefined),
  clickAxElement: vi.fn(async () => undefined),
  resolveWindowPoint: vi.fn(async () => ({ x: 100, y: 100 })),
  typeText: vi.fn(async () => undefined),
  pressKey: vi.fn(async () => undefined),
  pressAxElement: vi.fn(async () => undefined),
  setAxValue: vi.fn(async () => undefined),
  preflightPermissions: vi.fn(async () => ({ accessibilityTrusted: true, screenRecordingAllowed: true, source: "ax-helper" })),
}));

vi.mock("../e2e/local-e2e.js", () => ({
  captureE2eAppScreenshot: vi.fn(async () => ({ path: "/tmp/before-or-after.png", bytes: 1, opened: false, captureMode: "app-window" })),
  captureE2eScreenshot: vi.fn(async () => ({ path: "/tmp/screen.png", bytes: 1, opened: false, captureMode: "screen" })),
}));

// Import after the mocks so the executor module picks up the mocked bindings.
const macInput = await import("./mac-input.js");
const localE2e = await import("../e2e/local-e2e.js");
const { runExecutorOnce } = await import("./executor.js");

function makeCtx(stateDir: string, events: Array<Record<string, unknown>>): ToolContext {
  return {
    workspaceRoot: "/tmp",
    stateDir,
    registry: [],
    ledger: {
      append: async (event) => {
        events.push(event);
      },
    },
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async () => null,
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot: "/tmp",
      stateDir,
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

/** Like makeCtx, but with an active project selected (registry entry +
 * session activeProjectId), so resolveActiveProject(ctx) resolves rather
 * than short-circuiting captureActionEvidence to undefined. */
function makeCtxWithActiveProject(
  stateDir: string,
  projectRoot: string,
  events: Array<Record<string, unknown>>,
): ToolContext {
  const ctx = makeCtx(stateDir, events);
  const registry = [{ projectId: "proj", name: "proj", root: projectRoot, aliases: [] }];
  ctx.registry = registry;
  ctx.store = {
    loadProjects: async () => registry,
    saveProjects: async () => undefined,
    getSession: async () => ({ activeProjectId: "proj", mode: "read", lease: null }),
    setSession: async () => undefined,
  };
  return ctx;
}

describe("control/executor", () => {
  let stateDir: string;
  let events: Array<Record<string, unknown>>;
  let ctx: ToolContext;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-executor-"));
    events = [];
    ctx = makeCtx(stateDir, events);
    vi.mocked(macInput.resolveFrontmostApp).mockResolvedValue("TextEdit");
    vi.mocked(macInput.preflightPermissions).mockResolvedValue({
      accessibilityTrusted: true,
      screenRecordingAllowed: true,
      source: "ax-helper",
    });
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "TextEdit";
  });

  afterEach(async () => {
    delete process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST;
    vi.clearAllMocks();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("executes an approved click via mac-input and marks it done", async () => {
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "test",
    });
    await approveAction(stateDir, record.actionId);

    await runExecutorOnce(ctx);

    expect(macInput.resolveWindowPoint).toHaveBeenCalledWith("TextEdit", 0.5, 0.5);
    expect(macInput.clickAtPoint).toHaveBeenCalledWith("TextEdit", 100, 100);

    const final = await getAction(stateDir, record.actionId);
    expect(final?.status).toBe("done");
    expect(final?.result?.ok).toBe(true);

    const executed = events.find((e) => e.type === "control.action.executed");
    expect(executed).toMatchObject({ actionId: record.actionId, appName: "TextEdit", kind: "click", ok: true });
    // Never leaks raw input in the audit trail.
    expect(JSON.stringify(events)).not.toContain("super-secret");
  });

  it("does not execute a pending (unapproved) action", async () => {
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "type",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      text: "hello",
      reason: "test",
    });

    await runExecutorOnce(ctx);

    expect(macInput.typeText).not.toHaveBeenCalled();
    const final = await getAction(stateDir, record.actionId);
    expect(final?.status).toBe("pending");
  });

  it("blocks execution when the live frontmost app is sensitive, records control.action.blocked", async () => {
    vi.mocked(macInput.resolveFrontmostApp).mockResolvedValue("1Password 7");
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "key",
      target: {},
      keyCode: 36,
      reason: "test",
    });
    await approveAction(stateDir, record.actionId);

    await runExecutorOnce(ctx);

    expect(macInput.pressKey).not.toHaveBeenCalled();
    const final = await getAction(stateDir, record.actionId);
    expect(final?.status).toBe("done");
    expect(final?.result?.ok).toBe(false);
    expect(events.some((e) => e.type === "control.action.blocked")).toBe(true);
  });

  it("clamps an out-of-range windowPoint xRel/yRel before resolving it (HTTP action bridge zod-bypass defense in depth)", async () => {
    // The generic HTTP action bridge (src/server/actions.ts callRegisteredTool)
    // now re-validates against the registered zod schema, but this is
    // deliberate defense in depth in case some other path ever enqueues a
    // record without going through that schema — enqueue() itself does not
    // clamp, so an out-of-range record is exactly what a bypass would look
    // like on disk.
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 5, yRel: -3 } },
      reason: "test",
    });
    await approveAction(stateDir, record.actionId);

    await runExecutorOnce(ctx);

    expect(macInput.resolveWindowPoint).toHaveBeenCalledWith("TextEdit", 1, 0);
    const final = await getAction(stateDir, record.actionId);
    expect(final?.status).toBe("done");
    expect(final?.result?.ok).toBe(true);
  });

  it("rejects an out-of-range keyCode instead of handing it to pressKey/AppleScript (marks done, ok:false)", async () => {
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "key",
      target: {},
      keyCode: 9999,
      reason: "test",
    });
    await approveAction(stateDir, record.actionId);

    await runExecutorOnce(ctx);

    expect(macInput.pressKey).not.toHaveBeenCalled();
    const final = await getAction(stateDir, record.actionId);
    expect(final?.status).toBe("done");
    expect(final?.result?.ok).toBe(false);
  });

  it("never persists or returns a raw 'type' failure message (which can embed the typed secret via execFile's Command-failed argv echo)", async () => {
    vi.mocked(macInput.typeText).mockRejectedValueOnce(
      new Error('Command failed: /usr/bin/osascript -e keystroke "super-secret-password" ...'),
    );
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "type",
      target: {},
      text: "super-secret-password",
      reason: "test",
    });
    await approveAction(stateDir, record.actionId);

    await runExecutorOnce(ctx);

    // The on-disk record's own `text` field is intentionally raw/local-only
    // (see ControlActionRecord's doc comment) — the two sinks that must
    // never see the raw OS error message are `result.error` on the record
    // and the permanent ledger, both asserted below.
    const final = await getAction(stateDir, record.actionId);
    expect(final?.status).toBe("done");
    expect(final?.result?.ok).toBe(false);
    expect(final?.result?.error).toBe("type-failed");
    expect(JSON.stringify(final?.result)).not.toContain("super-secret-password");

    const executed = events.find((e) => e.type === "control.action.executed");
    expect(executed).toMatchObject({ ok: false, error: "type-failed" });
    expect(JSON.stringify(events)).not.toContain("super-secret-password");
  });

  it("executes an approved AX click via pressAxElement (re-resolved at actuation time), never touching windowPoint", async () => {
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "click",
      target: { ax: { role: "button", title: "OK" } },
      reason: "test",
      resolved: { found: true, role: "button", title: "OK", matchCount: 1, source: "system-events" },
    });
    await approveAction(stateDir, record.actionId);

    await runExecutorOnce(ctx);

    expect(macInput.pressAxElement).toHaveBeenCalledWith("TextEdit", { role: "button", title: "OK" });
    expect(macInput.resolveWindowPoint).not.toHaveBeenCalled();
    expect(macInput.clickAtPoint).not.toHaveBeenCalled();

    const final = await getAction(stateDir, record.actionId);
    expect(final?.status).toBe("done");
    expect(final?.result?.ok).toBe(true);
    const executed = events.find((e) => e.type === "control.action.executed");
    expect(executed).toMatchObject({ actionId: record.actionId, kind: "click", ok: true });
  });

  it("executes an approved AX type via setAxValue", async () => {
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "type",
      target: { ax: { role: "textField", title: "Name" } },
      text: "hello",
      reason: "test",
    });
    await approveAction(stateDir, record.actionId);

    await runExecutorOnce(ctx);

    expect(macInput.setAxValue).toHaveBeenCalledWith("TextEdit", { role: "textField", title: "Name" }, "hello");
    expect(macInput.typeText).not.toHaveBeenCalled();

    const final = await getAction(stateDir, record.actionId);
    expect(final?.status).toBe("done");
    expect(final?.result?.ok).toBe(true);
  });

  it("falls back to windowPoint when the AX re-resolve fails at actuation time (click)", async () => {
    vi.mocked(macInput.pressAxElement).mockRejectedValueOnce(new Error("element vanished"));
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "click",
      target: { ax: { role: "button", title: "Gone" }, windowPoint: { xRel: 0.3, yRel: 0.4 } },
      reason: "test",
    });
    await approveAction(stateDir, record.actionId);

    await runExecutorOnce(ctx);

    expect(macInput.pressAxElement).toHaveBeenCalled();
    expect(macInput.resolveWindowPoint).toHaveBeenCalledWith("TextEdit", 0.3, 0.4);
    expect(macInput.clickAtPoint).toHaveBeenCalledWith("TextEdit", 100, 100);

    const final = await getAction(stateDir, record.actionId);
    expect(final?.status).toBe("done");
    expect(final?.result?.ok).toBe(true);
  });

  it("fails (does not fall back to an arbitrary point) when AX re-resolve fails and there is no windowPoint", async () => {
    vi.mocked(macInput.pressAxElement).mockRejectedValueOnce(new Error("element vanished"));
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "click",
      target: { ax: { role: "button", title: "Gone" } },
      reason: "test",
    });
    await approveAction(stateDir, record.actionId);

    await runExecutorOnce(ctx);

    expect(macInput.clickAtPoint).not.toHaveBeenCalled();
    const final = await getAction(stateDir, record.actionId);
    expect(final?.status).toBe("done");
    expect(final?.result?.ok).toBe(false);
    expect(final?.result?.error).toContain("element vanished");
  });

  it("stops immediately once the session is killed", async () => {
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.2, yRel: 0.2 } },
      reason: "test",
    });
    await approveAction(stateDir, record.actionId);
    await setKill(stateDir);

    await runExecutorOnce(ctx);

    expect(macInput.clickAtPoint).not.toHaveBeenCalled();
    // setKill() itself rejects pending actions; approved ones simply are
    // never picked up by a killed executor.
    const final = await getAction(stateDir, record.actionId);
    expect(final?.status).not.toBe("done");
  });

  // --- Live permission preflight (item 3) ---------------------------------

  it("blocks with a clear reason when preflight definitively reports Accessibility isn't trusted", async () => {
    vi.mocked(macInput.preflightPermissions).mockResolvedValue({
      accessibilityTrusted: false,
      screenRecordingAllowed: true,
      source: "ax-helper",
    });
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "test",
    });
    await approveAction(stateDir, record.actionId);

    await runExecutorOnce(ctx);

    expect(macInput.clickAtPoint).not.toHaveBeenCalled();
    const final = await getAction(stateDir, record.actionId);
    expect(final?.status).toBe("done");
    expect(final?.result?.ok).toBe(false);
    expect(final?.result?.error).toBe("accessibility-permission-required");
    expect(events.some((e) => e.type === "control.action.blocked" && e.reason === "accessibility-permission-required")).toBe(true);
  });

  it("fails open (still executes) when preflight can't determine the trust state (source:'unavailable', e.g. no packaged helper)", async () => {
    vi.mocked(macInput.preflightPermissions).mockResolvedValue({
      accessibilityTrusted: false,
      screenRecordingAllowed: false,
      source: "unavailable",
      reason: "native helper not found",
    });
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "test",
    });
    await approveAction(stateDir, record.actionId);

    await runExecutorOnce(ctx);

    expect(macInput.clickAtPoint).toHaveBeenCalledWith("TextEdit", 100, 100);
    const final = await getAction(stateDir, record.actionId);
    expect(final?.status).toBe("done");
    expect(final?.result?.ok).toBe(true);
  });

  // --- Before/after screenshot evidence (item 4) --------------------------

  it("attaches best-effort before/after screenshot evidence to the executed ledger event and result when a project is active", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-executor-project-"));
    try {
      const activeCtx = makeCtxWithActiveProject(stateDir, projectRoot, events);
      const record = await enqueue(stateDir, {
        appName: "TextEdit",
        kind: "click",
        target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
        reason: "test",
      });
      await approveAction(stateDir, record.actionId);

      await runExecutorOnce(activeCtx);

      expect(localE2e.captureE2eAppScreenshot).toHaveBeenCalledTimes(2);
      const final = await getAction(stateDir, record.actionId);
      expect(final?.status).toBe("done");
      expect(final?.result?.ok).toBe(true);
      expect(final?.result?.evidence?.before).toBe("/tmp/before-or-after.png");
      expect(final?.result?.evidence?.after).toBe("/tmp/before-or-after.png");
      const executed = events.find((e) => e.type === "control.action.executed");
      expect(executed).toMatchObject({ evidence: { before: "/tmp/before-or-after.png", after: "/tmp/before-or-after.png" } });
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("never attempts screenshot capture for a sensitive-app target (defense in depth)", async () => {
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "1Password 7";
    vi.mocked(macInput.resolveFrontmostApp).mockResolvedValue("1Password 7");
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-executor-project-"));
    try {
      const activeCtx = makeCtxWithActiveProject(stateDir, projectRoot, events);
      const record = await enqueue(stateDir, {
        appName: "1Password 7",
        kind: "click",
        target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
        reason: "test",
      });
      await approveAction(stateDir, record.actionId);

      await runExecutorOnce(activeCtx);

      expect(localE2e.captureE2eAppScreenshot).not.toHaveBeenCalled();
      const final = await getAction(stateDir, record.actionId);
      expect(final?.result?.ok).toBe(false);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("evidence capture failures are swallowed (best-effort) and never affect action execution", async () => {
    vi.mocked(localE2e.captureE2eAppScreenshot).mockRejectedValue(new Error("screencapture failed"));
    vi.mocked(localE2e.captureE2eScreenshot).mockRejectedValue(new Error("screencapture failed"));
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-executor-project-"));
    try {
      const activeCtx = makeCtxWithActiveProject(stateDir, projectRoot, events);
      const record = await enqueue(stateDir, {
        appName: "TextEdit",
        kind: "click",
        target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
        reason: "test",
      });
      await approveAction(stateDir, record.actionId);

      await runExecutorOnce(activeCtx);

      const final = await getAction(stateDir, record.actionId);
      expect(final?.status).toBe("done");
      expect(final?.result?.ok).toBe(true);
      expect(final?.result?.evidence?.before).toBeUndefined();
      expect(final?.result?.evidence?.after).toBeUndefined();
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  // --- Bounded auto-approve (auto-approve-all) ----------------------------

  describe("auto-approve scope", () => {
    it("promotes and executes an in-scope pending action, marking it approvedVia:'auto'", async () => {
      await setAuto(stateDir, { apps: ["TextEdit"], minutes: 10 });
      const record = await enqueue(stateDir, {
        appName: "TextEdit",
        kind: "click",
        target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
        reason: "test",
      });

      await runExecutorOnce(ctx);

      expect(macInput.clickAtPoint).toHaveBeenCalledWith("TextEdit", 100, 100);
      const final = await getAction(stateDir, record.actionId);
      expect(final?.status).toBe("done");
      expect(final?.approvedVia).toBe("auto");
      expect(final?.result?.ok).toBe(true);

      const autoApproved = events.find((e) => e.type === "control.action.auto_approved");
      expect(autoApproved).toMatchObject({ actionId: record.actionId, appName: "TextEdit", kind: "click" });
      const executed = events.find((e) => e.type === "control.action.executed");
      expect(executed).toMatchObject({ actionId: record.actionId, approvedVia: "auto", ok: true });

      const scope = await readAuto(stateDir);
      expect(scope?.count).toBe(1);
    });

    it("does not promote a pending action for an app outside the auto scope; it stays pending", async () => {
      await setAuto(stateDir, { apps: ["Notes"], minutes: 10 });
      const record = await enqueue(stateDir, {
        appName: "TextEdit",
        kind: "click",
        target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
        reason: "test",
      });

      await runExecutorOnce(ctx);

      expect(macInput.clickAtPoint).not.toHaveBeenCalled();
      const final = await getAction(stateDir, record.actionId);
      expect(final?.status).toBe("pending");
    });

    it("never auto-approves a sensitive-app target even with an active, matching auto scope", async () => {
      process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "1Password 7";
      await setAuto(stateDir, { apps: ["1Password 7"], minutes: 10 });
      // setAuto itself filters sensitive apps out of scope.apps...
      const scope = await readAuto(stateDir);
      expect(scope?.apps).toEqual([]);

      const record = await enqueue(stateDir, {
        appName: "1Password 7",
        kind: "click",
        target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
        reason: "test",
      });

      await runExecutorOnce(ctx);

      expect(macInput.clickAtPoint).not.toHaveBeenCalled();
      const final = await getAction(stateDir, record.actionId);
      expect(final?.status).toBe("pending");
    });

    it("does not auto-approve once the scope has expired, and clears the AUTO file", async () => {
      await setAuto(stateDir, { apps: ["TextEdit"], minutes: 10 });
      // Force expiry (clampMinutes floors requested TTL at 1 minute, so
      // simulate the passage of time by rewriting expiresAt into the past
      // directly, matching how src/control/auto.test.ts exercises this).
      const scope = await readAuto(stateDir);
      await fs.writeFile(
        path.join(stateDir, "control", "AUTO"),
        JSON.stringify({ ...scope, expiresAt: Date.now() - 1000 }),
      );
      const record = await enqueue(stateDir, {
        appName: "TextEdit",
        kind: "click",
        target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
        reason: "test",
      });

      await runExecutorOnce(ctx);

      expect(macInput.clickAtPoint).not.toHaveBeenCalled();
      const final = await getAction(stateDir, record.actionId);
      expect(final?.status).toBe("pending");
      expect(await readAuto(stateDir)).toBeNull();
    });

    it("kill switch clears the auto scope and rejects everything, even mid-scope", async () => {
      await setAuto(stateDir, { apps: ["TextEdit"], minutes: 10 });
      const record = await enqueue(stateDir, {
        appName: "TextEdit",
        kind: "click",
        target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
        reason: "test",
      });

      await setKill(stateDir);

      expect(await readAuto(stateDir)).toBeNull();
      const final = await getAction(stateDir, record.actionId);
      expect(final?.status).toBe("rejected");

      await runExecutorOnce(ctx);
      expect(macInput.clickAtPoint).not.toHaveBeenCalled();
    });

    it("respects maxCount across a scope shared by multiple pending actions", async () => {
      await setAuto(stateDir, { apps: ["TextEdit"], minutes: 10, maxCount: 1 });
      const a = await enqueue(stateDir, {
        appName: "TextEdit",
        kind: "click",
        target: { windowPoint: { xRel: 0.1, yRel: 0.1 } },
        reason: "a",
      });
      const b = await enqueue(stateDir, {
        appName: "TextEdit",
        kind: "click",
        target: { windowPoint: { xRel: 0.2, yRel: 0.2 } },
        reason: "b",
      });

      await runExecutorOnce(ctx);

      const finalA = await getAction(stateDir, a.actionId);
      const finalB = await getAction(stateDir, b.actionId);
      const doneCount = [finalA, finalB].filter((r) => r?.status === "done").length;
      const pendingCount = [finalA, finalB].filter((r) => r?.status === "pending").length;
      expect(doneCount).toBe(1);
      expect(pendingCount).toBe(1);
    });

    afterEach(async () => {
      await clearAuto(stateDir).catch(() => undefined);
    });
  });
});

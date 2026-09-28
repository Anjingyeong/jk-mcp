import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../state/store.js";
import { ErrorCode, type ProjectRegistryEntry, type ToolContext } from "../types.js";
import { deriveLocalExecutionTarget } from "../executors/target-protocol.js";
import { makeLease } from "../workspace/project-select.js";
import { bindExecutionLease, requireProjectLease } from "./tools.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(remote = true, durable = true) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jk-mobile-reconnect-"));
  roots.push(temp);
  const projectRoot = path.join(temp, "project");
  const stateDir = path.join(temp, "state");
  await fs.mkdir(projectRoot);
  const entry: ProjectRegistryEntry = {
    projectId: "proj",
    name: "proj",
    root: projectRoot,
    aliases: [],
    executionTarget: await deriveLocalExecutionTarget(temp, { projectId: "proj", root: projectRoot }),
  };
  const store = new Store(stateDir);
  await store.saveProjects([entry]);
  const expired = { ...bindExecutionLease(makeLease(entry, "full-write"), entry), expiresAt: 0 };
  const taskState = {
    lifecycle: "active" as const,
    goalId: "goal-mobile",
    loopId: "loop-mobile",
    currentGoal: "Continue after mobile reconnect",
    currentTask: "resume",
    lastProgressSummary: null,
    completed: [],
    pending: ["resume"],
    decisions: [],
    continuation: null,
    executionSafety: {},
    updatedAt: Date.now(),
  };
  const workContext = {
    projectId: "proj",
    workSessionId: "ws_mobile",
    activeArtifact: null,
    recentFiles: [],
    lastCheckpointId: null,
    lastMutation: null,
    lastVerification: null,
    taskState,
    lastActivityAt: Date.now(),
  };
  await store.setSession({
    activeProjectId: "proj",
    mode: "edit",
    lease: expired,
    workContexts: {},
    workSessions: durable ? { proj: { ws_mobile: workContext } } : {},
  });
  const events: Array<Record<string, unknown>> = [];
  const ctx: ToolContext = {
    workspaceRoot: temp,
    stateDir,
    registry: [entry],
    store,
    ledger: { append: async (event) => { events.push(event); } },
    config: {
      workspaceRoot: temp,
      stateDir,
      maxReadBytes: 10_000,
      maxPatchBytes: 10_000,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 60_000,
    },
    remote,
  };
  return { ctx, store, expired, events };
}

describe("mobile reconnect lease recovery", () => {
  it("reacquires an expired non-control lease for a durable remote work session", async () => {
    const { ctx, store, expired, events } = await fixture(true, true);
    const recovered = await requireProjectLease(ctx, "proj", "write");
    expect(recovered.expiresAt).toBeGreaterThan(Date.now());
    expect(recovered.leaseId).not.toBe(expired.leaseId);
    expect((await store.getSession()).lease).toMatchObject({ leaseId: recovered.leaseId, preset: "full-write" });
    expect(events).toContainEqual(expect.objectContaining({ type: "project.lease.recovered", projectId: "proj", reason: "remote-reconnect" }));
  });

  it.each([
    { label: "local callers", remote: false, durable: true },
    { label: "remote calls without durable work context", remote: true, durable: false },
  ])("does not silently reacquire for $label", async ({ remote, durable }) => {
    const { ctx, events } = await fixture(remote, durable);
    await expect(requireProjectLease(ctx, "proj", "write")).rejects.toMatchObject({ code: ErrorCode.LEASE_REQUIRED });
    expect(events).toEqual([]);
  });
});

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../state/store.js";
import { ErrorCode, type Lease, type ProjectRegistryEntry, type ToolContext } from "../types.js";
import { deriveLocalExecutionTarget } from "../executors/target-protocol.js";
import { makeLease } from "../workspace/project-select.js";
import { bindExecutionLease, requireProjectLease } from "./tools.js";

const TTL_MS = 60_000;
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jk-lease-slide-"));
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
  const issuedAt = Date.now();
  const lease: Lease = { ...bindExecutionLease(makeLease(entry, "full-write", TTL_MS), entry), issuedAt, expiresAt: issuedAt + TTL_MS };
  await store.setSession({ activeProjectId: "proj", mode: "edit", lease, workContexts: {}, workSessions: {} });
  const ctx: ToolContext = {
    workspaceRoot: temp,
    stateDir,
    registry: [entry],
    store,
    ledger: { append: async () => undefined },
    config: {
      workspaceRoot: temp,
      stateDir,
      maxReadBytes: 10_000,
      maxPatchBytes: 10_000,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: TTL_MS,
    },
    remote: false,
  };
  return { ctx, store, lease, issuedAt };
}

async function storedLease(store: Store): Promise<Lease> {
  return ((await store.getSession()) as { lease: Lease }).lease;
}

describe("project lease sliding renewal", () => {
  it("extends a lease in use past half its TTL and keeps its identity", async () => {
    const { ctx, store, lease, issuedAt } = await fixture();
    const now = issuedAt + 40_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const renewed = await requireProjectLease(ctx, "proj", "write");

    expect(renewed.leaseId).toBe(lease.leaseId);
    expect(renewed.expiresAt).toBe(now + TTL_MS);
    expect(await storedLease(store)).toMatchObject({ leaseId: lease.leaseId, expiresAt: now + TTL_MS });
  });

  it("leaves a fresh lease untouched", async () => {
    const { ctx, store, lease, issuedAt } = await fixture();
    vi.spyOn(Date, "now").mockReturnValue(issuedAt + 10_000);

    const current = await requireProjectLease(ctx, "proj", "write");

    expect(current.expiresAt).toBe(lease.expiresAt);
    expect((await storedLease(store)).expiresAt).toBe(lease.expiresAt);
  });

  it("still expires a lease left idle past its TTL", async () => {
    const { ctx, issuedAt } = await fixture();
    vi.spyOn(Date, "now").mockReturnValue(issuedAt + TTL_MS + 1_000);

    await expect(requireProjectLease(ctx, "proj", "write")).rejects.toMatchObject({ code: ErrorCode.LEASE_REQUIRED });
  });

});

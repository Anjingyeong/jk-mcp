import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { EventEmitter, once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../types.js";
import {
  consumeLocalShellApprovalGrant as consume, hasActiveTaskNetworkApproval,
  listPendingLocalShellApprovals, localShellApprovalId,
  requestLocalShellApproval as request, resolveLocalShellApproval as resolve,
  type LocalShellApprovalInput,
} from "./local-approvals.js";
import { consumeLocalShellTaskBundle, localShellBundleFingerprint, localShellTaskBundleId } from "./local-approval-bundles.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  vi.stubEnv("JK_NTFY_TOPIC", "");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jk-approval-authority-"));
  roots.push(dir);
  return dir;
}
const identity = { projectId: "proj", cwd: ".", taskKey: "task:goal:qa", workSessionId: "ws_qa" };
function input(command = "qa-A", overrides: Partial<LocalShellApprovalInput> = {}): LocalShellApprovalInput {
  return { projectId: "proj", cwd: ".", taskIdentity: "goal:qa", workSessionId: "ws_qa",
    command, needsNetwork: false, destructive: true, ...overrides };
}
function bundled(commands = ["qa-A", "qa-B"]): LocalShellApprovalInput {
  return input(commands[0], { bundle: { label: "QA bundle", entries: commands.map((command) =>
    ({ command, needsNetwork: false, destructive: true })), ttlMs: 120_000 } });
}
const key = (command: string) => createHash("sha256").update(JSON.stringify({ command, needsNetwork: false, destructive: true })).digest("hex");
const marker = (dir: string, id: string) => path.join(dir, "approvals", "shell", `${id}.json`);
const bundleDir = (dir: string) => path.join(dir, "approvals", "shell", "task-bundles");
async function bundleFiles(dir: string) {
  return (await fs.readdir(bundleDir(dir))).filter((file) => /^[a-f0-9]{64}\.json$/.test(file));
}
async function approved(dir: string, commands = ["qa-A", "qa-B"]) {
  const record = await request(dir, bundled(commands));
  await resolve(dir, record.id, "approve");
  return record;
}

describe("immutable approval authority", () => {
  it("keeps a displayed pending approval immutable when a wider bundle is requested", async () => {
    const dir = await fixture();
    const first = await request(dir, input());
    const snapshot = await fs.readFile(marker(dir, first.id), "utf8");
    const retry = await request(dir, bundled());
    const unchanged = await fs.readFile(marker(dir, first.id), "utf8");
    await resolve(dir, first.id, "approve");
    const b = await consume(dir, input("qa-B"));
    expect(retry).toEqual(first);
    expect(unchanged).toBe(snapshot);
    expect(b).toBeNull();
    expect(await consume(dir, input())).toMatchObject({ approvalId: first.id });
    expect(await consume(dir, input())).toBeNull();
  });

  it("serializes competing initial requests without changing the first published consent", async () => {
    const dir = await fixture();
    const events = new EventEmitter();
    const entered = once(events, "published", { signal: AbortSignal.timeout(5000) });
    const released = once(events, "release", { signal: AbortSignal.timeout(5000) });
    const rename = fs.rename;
    let hold = true;
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      await rename(source, target);
      if (String(target) === marker(dir, localShellApprovalId(input())) && hold) {
        hold = false;
        events.emit("published");
        await released;
      }
    });
    const first = request(dir, input());
    await entered;
    const contender = request(dir, bundled());
    events.emit("release");
    const results = await Promise.all([first, contender]);
    expect(results[1]).toEqual(results[0]);
    expect(await listPendingLocalShellApprovals(dir)).toEqual([results[0]]);
  });

  it("does not widen pending scope or ttl on retry", async () => {
    const dir = await fixture();
    const first = await request(dir, input("qa-A", { scope: { key: "maintenance:jk:narrow", label: "narrow", ttlMs: 60_000 } }));
    const snapshot = await fs.readFile(marker(dir, first.id), "utf8");
    expect(await request(dir, { ...bundled(), reason: "changed", scope: { key: "maintenance:jk:wide", label: "wide", ttlMs: 900_000 } })).toEqual(first);
    expect(await fs.readFile(marker(dir, first.id), "utf8")).toBe(snapshot);
  });

  it("debits one bundled command once across exact and bundle consumers", async () => {
    const dir = await fixture();
    const record = await approved(dir);
    const events = new EventEmitter();
    const entered = once(events, "claimed", { signal: AbortSignal.timeout(5000) });
    const released = once(events, "release", { signal: AbortSignal.timeout(5000) });
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      await rename(source, target);
      if (String(source) === marker(dir, record.id) && String(target).endsWith(".consumed")) {
        events.emit("claimed");
        await released;
      }
    });
    const exact = consume(dir, input());
    await entered;
    let direct;
    try {
      direct = await consumeLocalShellTaskBundle(dir, { ...identity, commandKey: key("qa-A") });
    } finally {
      events.emit("release");
    }
    expect([await exact, direct].filter(Boolean)).toHaveLength(1);
    expect(await consume(dir, input())).toBeNull();
    expect(await consume(dir, input("qa-B"))).toMatchObject({ approvalId: record.id });
    expect(await consume(dir, input("qa-B"))).toBeNull();
  });
  it("does not grant a bundled exact marker when its matching debit is absent", async () => {
    const dir = await fixture();
    await approved(dir);
    for (const file of await bundleFiles(dir)) await fs.unlink(path.join(bundleDir(dir), file));
    const other = await approved(dir, ["qa-C", "qa-A"]);
    expect(await consume(dir, input())).toBeNull();
    expect(await consumeLocalShellTaskBundle(dir, { ...identity, commandKey: key("qa-A") })).toMatchObject({ approvalId: other.id });
  });

  it("does not refill a bundle when resolution is retried", async () => {
    const dir = await fixture();
    const record = await approved(dir);
    expect(await consume(dir, input("qa-B"))).toMatchObject({ approvalId: record.id });
    await resolve(dir, record.id, "approve");
    expect(await consume(dir, input("qa-B"))).toBeNull();
    expect(await consume(dir, input())).toMatchObject({ approvalId: record.id });
    expect(await consume(dir, input())).toBeNull();
  });

  it("retains disjoint unspent bundles for one task and session", async () => {
    const dir = await fixture();
    const a = await approved(dir, ["qa-A1", "qa-A2"]);
    await consume(dir, input("qa-A1"));
    const b = await approved(dir, ["qa-B1", "qa-B2"]);
    for (const overrides of [{ taskIdentity: "other" }, { workSessionId: "other" }, { cwd: "other" }, { destructive: false }]) {
      expect(await consume(dir, input("qa-A2", overrides))).toBeNull();
    }
    for (const [command, record] of [["qa-A2", a], ["qa-B1", b], ["qa-B2", b]] as const) {
      expect(await consume(dir, input(command))).toMatchObject({ approvalId: record.id, bundleFingerprint: record.bundleFingerprint });
      expect(await consume(dir, input(command))).toBeNull();
    }
    expect(await bundleFiles(dir)).toHaveLength(2);
  });

  it("spends legacy authority in place beside a new disjoint bundle", async () => {
    const dir = await fixture();
    const id = localShellTaskBundleId(identity);
    const commandKeys = [key("qa-A1"), key("qa-A2")];
    const legacy = { ...identity, id, approvalId: "a".repeat(64), label: "legacy", commandKeys,
      bundleFingerprint: localShellBundleFingerprint({ ...identity, commandKeys }),
      remainingCommandKeys: [key("qa-A2")], createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
    await fs.mkdir(bundleDir(dir), { recursive: true });
    const file = path.join(bundleDir(dir), `${id}.json`);
    await fs.writeFile(file, JSON.stringify(legacy));
    const b = await approved(dir, ["qa-B1", "qa-B2"]);
    expect(await consume(dir, input("qa-A2"))).toMatchObject({ approvalId: legacy.approvalId });
    expect(await consume(dir, input("qa-A1"))).toBeNull();
    expect(await consume(dir, input("qa-A2"))).toBeNull();
    expect(await consume(dir, input("qa-B2"))).toMatchObject({ approvalId: b.id });
    expect(await consume(dir, input("qa-B2"))).toBeNull();
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ ...legacy, remainingCommandKeys: [] });
    expect(await bundleFiles(dir)).toHaveLength(2);
  });

  it("repairs interrupted bundle publication without extending or duplicating authority", async () => {
    const dir = await fixture();
    const record = await request(dir, bundled());
    const failure = Object.assign(new Error("publication failed"), { code: "EIO" });
    const rename = fs.rename;
    let fail = true;
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (path.dirname(String(target)) === bundleDir(dir) && String(target).endsWith(".json") && fail) {
        fail = false;
        throw failure;
      }
      await rename(source, target);
    });
    await expect(resolve(dir, record.id, "approve")).rejects.toBe(failure);
    const durable = JSON.parse(await fs.readFile(marker(dir, record.id), "utf8"));
    expect(durable).toMatchObject({ status: "approved", resolvedDecision: "approve" });
    vi.spyOn(Date, "now").mockReturnValue(durable.resolvedAt + 1000);
    expect(await resolve(dir, record.id, "deny")).toMatchObject({ status: "approved", resolvedAt: durable.resolvedAt });
    expect(await consume(dir, input("qa-B"))).toMatchObject({ approvalId: record.id, createdAt: durable.resolvedAt, expiresAt: durable.resolvedAt + 120_000 });
    await resolve(dir, record.id, "approve");
    expect(await consume(dir, input("qa-B"))).toBeNull();
    expect(await bundleFiles(dir)).toHaveLength(1);
  });

  it.each(["json", "duplicate", "undeclared", "fingerprint", "file-id", "timestamps", "approval-json", "approval-risk", "approval-fingerprint"])("fails closed on invalid persisted approval authority: %s", async (kind) => {
    const dir = await fixture();
    const record = await approved(dir);
    const files = await bundleFiles(dir);
    const file = kind.startsWith("approval-") ? marker(dir, record.id) : path.join(bundleDir(dir), files[0] ?? "missing");
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (kind === "duplicate") value.remainingCommandKeys.push(value.remainingCommandKeys[0]);
    if (kind === "undeclared") value.remainingCommandKeys.push(key("qa-foreign"));
    if (kind === "fingerprint" || kind === "approval-fingerprint") value.bundleFingerprint = "f".repeat(64);
    if (kind === "file-id") value.id = "f".repeat(64);
    if (kind === "timestamps") value.createdAt = value.expiresAt + 1;
    if (kind === "approval-risk") value.destructive = "false";
    await fs.writeFile(file, kind === "json" || kind === "approval-json" ? "{" : JSON.stringify(value));
    await expect(consume(dir, input(kind.startsWith("approval-") ? "qa-A" : "qa-B"))).rejects.toBeInstanceOf(DomainError);
  });

  it.each(["expired", "task", "session", "project", "cwd"])("fails closed on invalid persisted approval authority: valid %s", async (kind) => {
    const dir = await fixture();
    await approved(dir);
    if (kind === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_800_000);
    const overrides = kind === "task" ? { taskIdentity: "foreign" } : kind === "session" ? { workSessionId: "foreign" }
      : kind === "project" ? { projectId: "foreign" } : kind === "cwd" ? { cwd: "foreign" } : {};
    expect(await consume(dir, input("qa-B", overrides))).toBeNull();
  });

  it("propagates debit io failure without granting or poisoning the lock", async () => {
    const dir = await fixture();
    const record = await approved(dir);
    const failure = Object.assign(new Error("debit failed"), { code: "EIO" });
    const rename = fs.rename;
    let fail = true;
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (path.dirname(String(target)) === bundleDir(dir) && String(target).endsWith(".json") && fail) {
        fail = false;
        throw failure;
      }
      await rename(source, target);
    });
    await expect(consume(dir, input())).rejects.toBe(failure);
    expect(await consume(dir, input())).toMatchObject({ approvalId: record.id });
    expect(await consume(dir, input())).toBeNull();
  });

  it("does not reconstruct missing authority from a legacy approved marker", async () => {
    const dir = await fixture();
    const record = await approved(dir);
    const file = marker(dir, record.id);
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    delete value.resolvedDecision;
    await fs.writeFile(file, JSON.stringify(value));
    for (const bundle of await bundleFiles(dir)) await fs.unlink(path.join(bundleDir(dir), bundle));
    await resolve(dir, record.id, "approve");
    expect(await consume(dir, input())).toBeNull();
    expect(await bundleFiles(dir)).toHaveLength(0);
  });

  it.each(["projectId", "cwd", "taskIdentity", "workSessionId", "destructive"])("fails closed on invalid persisted approval authority: foreign exact %s", async (field) => {
    const dir = await fixture();
    const record = await request(dir, input());
    await resolve(dir, record.id, "approve");
    const file = marker(dir, record.id);
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    value[field] = field === "destructive" ? false : "foreign";
    await fs.writeFile(file, JSON.stringify(value));
    expect(await consume(dir, input())).toBeNull();
  });

  it.each(["taskIdentity", "workSessionId"])("preserves full normalized owner identity for bundle authority: %s", async (field) => {
    const dir = await fixture();
    const owner = { [field]: `  owner-${"x".repeat(260)}  ` };
    const record = await request(dir, { ...bundled(), ...owner });
    await resolve(dir, record.id, "approve");
    expect(await consume(dir, input("qa-B", owner))).toMatchObject({ approvalId: record.id });
    expect(await consume(dir, input("qa-B", owner))).toBeNull();
  });

  it.each(["scopes", "supervised"])("fails closed on invalid persisted approval authority: %s timestamps", async (kind) => {
    const dir = await fixture();
    const scoped = input("qa-network", { needsNetwork: true, destructive: false,
      scope: { key: "network-read:qa", label: "QA" } });
    const record = await request(dir, scoped);
    await resolve(dir, record.id, kind === "scopes" ? "approve" : "supervise");
    const directory = path.join(dir, "approvals", "shell", kind);
    const files = await fs.readdir(directory);
    const file = path.join(directory, files[0] ?? "missing");
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    value.createdAt = value.expiresAt + 1;
    await fs.writeFile(file, JSON.stringify(value));
    const followup = { ...scoped, command: "qa-followup", taskIdentity: kind === "scopes" ? "other" : scoped.taskIdentity };
    await expect(consume(dir, followup)).rejects.toBeInstanceOf(DomainError);
  });

  it("expires supervised authority at exactly fifteen minutes", async () => {
    const dir = await fixture();
    const start = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    const record = await request(dir, input("qa-network", { needsNetwork: true, destructive: false }));
    await resolve(dir, record.id, "supervise");
    vi.spyOn(Date, "now").mockReturnValue(start + 899_999);
    expect(await hasActiveTaskNetworkApproval(dir, input())).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(start + 900_000);
    expect(await hasActiveTaskNetworkApproval(dir, input())).toBe(false);
  });
});

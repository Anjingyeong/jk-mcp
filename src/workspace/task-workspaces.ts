import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { listCommands, runCommand } from "../exec/command-runner.js";
import { acquireMassUlwLock } from "../orchestration/mass-ulw-lock.js";
import { auditChanges, treeChanges } from "../orchestration/mass-ulw-workspace-changes.js";
import { createSnapshotCommit, fingerprintMassUlwRepository, git, requireRepositoryRoot, restoreOriginalCheckout } from "../orchestration/mass-ulw-workspace-repository.js";
import { publishMassUlwWorkspace } from "../orchestration/mass-ulw-workspace-publish.js";
import { publicationTransactionRoot, recoverMassUlwPublication } from "../orchestration/mass-ulw-publish-recovery.js";
import { DomainError, ErrorCode, type ProjectRegistryEntry } from "../types.js";
import { redact } from "../policy/secrets.js";

const PREFIX = "jk-task-";
const Id = z.string().regex(/^jk-task-[a-f0-9]{24}$/u);
const Fingerprint = z.object({
  digest: z.string(), head: z.string(), indexDigest: z.string(), index: z.string(),
  entries: z.array(z.object({ path: z.string(), kind: z.enum(["file", "symlink", "missing"]), mode: z.number(), digest: z.string() })),
});
const Proof = z.object({
  id: z.string(), fingerprint: z.string(), commandId: z.string(), manifestFingerprint: z.string(),
  exitCode: z.number(), passed: z.boolean(), at: z.number(), durationMs: z.number(),
  stdoutSummary: z.string(), stderrSummary: z.string(),
});
const Document = z.object({
  version: z.literal(1), id: Id, sourceProjectId: z.string(), sourceRoot: z.string(),
  name: z.string(), workSessionId: z.string(), goal: z.string(),
  status: z.enum(["active", "archived", "published", "discarded"]),
  baselineCommit: z.string(), initialFingerprint: Fingerprint,
  createdAt: z.number(), updatedAt: z.number(), revision: z.number().int().nonnegative(),
  verification: Proof.nullable(), review: z.object({ verificationId: z.string(), fingerprint: z.string(), summary: z.string(), at: z.number() }).nullable(),
  changedPaths: z.array(z.string()),
});
export type TaskWorkspace = z.infer<typeof Document>;
export const isTaskWorkspaceId = (value: string): boolean => Id.safeParse(value).success;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
function fail(message: string): never { throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, message); }

/** Persistent private clones; no model client, credential, or provider dependency. */
export class TaskWorkspaceStore {
  readonly base: string;
  constructor(readonly stateDir: string) { this.base = path.resolve(stateDir, "task-workspaces"); }
  directory(id: string): string { return path.join(this.base, Id.parse(id)); }
  root(id: string): string { return path.join(this.directory(id), "merged"); }

  private async ensureBase(): Promise<void> {
    await fs.mkdir(this.base, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.base)).isSymbolicLink()) fail("Task workspace storage must not be a symlink");
  }
  private async safeDirectory(id: string, checkout = false, requireGit = true): Promise<void> {
    const base = await fs.realpath(this.base);
    const directory = this.directory(id);
    if ((await fs.lstat(directory)).isSymbolicLink()) fail("Task workspace directory was replaced by a symlink");
    const resolved = await fs.realpath(directory);
    if (path.dirname(resolved) !== base) fail("Task workspace escaped its managed storage");
    if (checkout) {
      const root = this.root(id);
      if ((await fs.lstat(root)).isSymbolicLink() || path.dirname(await fs.realpath(root)) !== resolved) {
        fail("Task checkout escaped its managed workspace");
      }
      if (requireGit) await requireRepositoryRoot(root);
    }
  }
  async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const lock = await this.acquire(id);
    try { return await action(); } finally { await lock.release(); }
  }
  async acquire(id: string): Promise<{ release(): Promise<void> }> {
    Id.parse(id);
    await this.ensureBase();
    return acquireMassUlwLock({ path: path.join(this.base, `${id}.lock`), now: Date.now, lockedMessage: "Task workspace is busy; retry after its current tool completes" });
  }
  async load(id: string): Promise<TaskWorkspace> {
    await this.safeDirectory(id);
    const record = Document.parse(JSON.parse(await fs.readFile(path.join(this.directory(id), "state.json"), "utf8")));
    if (record.id !== id) fail("Task workspace identity does not match its state directory");
    return record;
  }
  private async save(record: TaskWorkspace): Promise<TaskWorkspace> {
    await this.safeDirectory(record.id);
    const next = Document.parse({ ...record, updatedAt: Date.now(), revision: record.revision + 1 });
    const target = path.join(this.directory(record.id), "state.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(next, null, 2)); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temporary, target); } finally { await fs.rm(temporary, { force: true }); }
    return next;
  }
  async list(): Promise<TaskWorkspace[]> {
    const entries = await fs.readdir(this.base, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const result: TaskWorkspace[] = [];
    for (const entry of entries) {
      if (!Id.safeParse(entry.name).success) continue;
      // A missing state file is an interrupted creation, never an active checkout.
      if (!(await fs.stat(path.join(this.directory(entry.name), "state.json")).catch(() => null))) continue;
      result.push(await this.load(entry.name));
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  project(record: TaskWorkspace): ProjectRegistryEntry {
    return { projectId: record.id, name: `${record.name} · ${record.workSessionId}`, root: this.root(record.id), aliases: [], executorKind: "local" };
  }
  async assertActive(id: string): Promise<TaskWorkspace> {
    const record = await this.load(id);
    if (record.status !== "active") fail(`Task workspace is ${record.status}; resume it explicitly before using project tools`);
    await this.safeDirectory(id, true);
    return record;
  }
  async create(source: ProjectRegistryEntry, workSessionId: string, goal: string): Promise<TaskWorkspace> {
    if (source.executorKind === "remote" || isTaskWorkspaceId(source.projectId)) fail("Create a task workspace from a local source project, not another task workspace");
    const { root } = await requireRepositoryRoot(source.root);
    const requireExternalStorage = (location: string) => {
      const relative = path.relative(root, location);
      if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
        fail("Task workspace storage must be outside the source repository; configure a separate JK state directory");
      }
    };
    requireExternalStorage(this.base);
    await this.ensureBase();
    requireExternalStorage(await fs.realpath(this.base));
    const id = `${PREFIX}${digest(`${source.projectId}\0${root}\0${workSessionId}`).slice(0, 24)}`;
    return this.locked(id, async () => {
      const statePath = path.join(this.directory(id), "state.json");
      if (await fs.stat(statePath).catch(() => null)) {
        const existing = await this.load(id);
        if (existing.goal !== goal) fail("This workSessionId already belongs to a different goal; use a new workSessionId");
        return this.assertActive(id);
      }
      // Expose an identity only after the complete clone and state are durable.
      // A process crash in staging cannot make a half-built checkout selectable.
      const staging = await fs.mkdtemp(path.join(this.base, `.creating-${id}-`));
      const checkout = path.join(staging, "merged");
      try {
        const fingerprint = await fingerprintMassUlwRepository(root);
        await git(staging, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", root, checkout]);
        await git(checkout, ["remote", "remove", "origin"]);
        const fileMode = (await git(root, ["config", "--bool", "core.filemode"])).trim();
        await git(checkout, ["config", "core.filemode", fileMode || "false"]);
        await git(checkout, ["checkout", "--quiet", "--detach", fingerprint.head]);
        await restoreOriginalCheckout(root, checkout, fingerprint);
        const baselineCommit = await createSnapshotCommit(checkout, fingerprint.head, staging);
        await git(checkout, ["reset", "--mixed", baselineCommit]);
        await fs.appendFile(path.join(checkout, ".git", "info", "exclude"), "\n/.jk/\n/.chatgpt2codex/\n");
        if ((await fingerprintMassUlwRepository(root)).digest !== fingerprint.digest) fail("Source changed while creating workspace; retry creation");
        const record = Document.parse({ version: 1, id, sourceProjectId: source.projectId, sourceRoot: root, name: source.name,
          workSessionId, goal, status: "active", baselineCommit, initialFingerprint: fingerprint,
          createdAt: Date.now(), updatedAt: Date.now(), revision: 1, verification: null, review: null, changedPaths: [] });
        const handle = await fs.open(path.join(staging, "state.json"), "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(record, null, 2)); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(staging, this.directory(id));
        return record;
      } finally {
        const resolved = await fs.realpath(staging).catch(() => null);
        if (resolved && path.dirname(resolved) === await fs.realpath(this.base) && !(await fs.lstat(staging)).isSymbolicLink()) {
          await fs.rm(staging, { recursive: true, force: true });
        }
      }
    });
  }
  async fingerprint(id: string): Promise<string> { await this.safeDirectory(id, true); return (await fingerprintMassUlwRepository(this.root(id))).digest; }
  async status(id: string): Promise<Record<string, unknown>> {
    const record = await this.load(id);
    const fingerprint = record.status === "discarded" ? null : await this.fingerprint(id);
    return { ...record, initialFingerprint: undefined, root: this.root(id), fingerprint,
      verificationCurrent: Boolean(record.verification?.passed && record.verification.fingerprint === fingerprint),
      nextAction: record.status !== "active" ? record.status : record.verification?.passed && record.verification.fingerprint === fingerprint ? "review-and-publish" : "inspect-edit-verify",
      reasoningSurface: "chatgpt-web", externalModelRequired: false };
  }
  async verify(id: string, commandId: string, timeoutSec?: number): Promise<TaskWorkspace> {
    let record = await this.assertActive(id);
    const command = (await listCommands(this.root(id))).find((item) => item.commandId === commandId);
    if (!command || command.riskTier !== "verify") fail("Workspace verification requires a manifest-discovered verify command");
    const before = await this.fingerprint(id);
    // A timeout, spawn failure, or process crash must not leave an older pass usable.
    record = await this.save({ ...record, verification: null, review: null });
    const result = await runCommand(this.root(id), commandId, undefined, timeoutSec, command.manifestFingerprint);
    const after = await this.fingerprint(id);
    return this.save({ ...record, review: null, verification: {
      id: `verification_${randomUUID()}`, fingerprint: after, commandId, manifestFingerprint: command.manifestFingerprint,
      exitCode: result.exitCode, passed: result.exitCode === 0 && before === after, at: Date.now(),
      durationMs: result.durationMs, stdoutSummary: redact(result.stdoutSummary), stderrSummary: redact(result.stderrSummary),
    } });
  }
  async assertVerified(id: string, verificationId?: string): Promise<TaskWorkspace> {
    const record = await this.assertActive(id);
    const webMassRaw = await fs.readFile(path.join(this.directory(id), "mass-ulw-web.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (webMassRaw !== null) {
      const workflow = z.object({ projectId: Id, integration: z.object({ status: z.literal("applied"), appliedFingerprint: z.string(), review: z.string().min(1), proof: z.object({ passed: z.literal(true) }) }) }).safeParse(JSON.parse(webMassRaw));
      if (!workflow.success || workflow.data.projectId !== id || workflow.data.integration.appliedFingerprint !== await this.fingerprint(id)) {
        fail("The active MASS ULW workflow must finish its integrated verification and review for these exact task changes before completion or publication");
      }
    }
    const proof = record.verification;
    if (!proof?.passed || (verificationId && verificationId !== proof.id) || proof.fingerprint !== await this.fingerprint(id)) {
      fail("Current workspace changes have no matching successful verification; call task_workspace verify");
    }
    const command = (await listCommands(this.root(id))).find((item) => item.commandId === proof.commandId);
    if (!command || command.manifestFingerprint !== proof.manifestFingerprint) fail("Verification command changed; verify again");
    return record;
  }
  async archive(id: string): Promise<TaskWorkspace> { return this.save({ ...await this.assertActive(id), status: "archived" }); }
  async resume(id: string): Promise<TaskWorkspace> {
    const record = await this.load(id);
    if (!["active", "archived"].includes(record.status)) fail(`Cannot resume a ${record.status} workspace`);
    await this.safeDirectory(id, true);
    return this.save({ ...record, status: "active" });
  }
  async discard(id: string, expectedFingerprint: string): Promise<TaskWorkspace> {
    const record = await this.load(id);
    if (record.status === "discarded") {
      // Retry cleanup if a crash/file lock interrupted deletion after the tombstone.
      const checkout = await fs.lstat(this.root(id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (checkout) {
        await this.safeDirectory(id, true, false);
        await fs.rm(this.root(id), { recursive: true, force: true });
      }
      return record;
    }
    if (expectedFingerprint !== await this.fingerprint(id)) fail("Workspace changed since discard was prepared");
    // Keep identity/state as a tombstone. Delete only the validated managed checkout.
    await this.safeDirectory(id, true);
    const saved = await this.save({ ...record, status: "discarded" });
    await fs.rm(this.root(id), { recursive: true, force: true });
    return saved;
  }
  async publish(id: string, verificationId: string, reviewSummary: string): Promise<TaskWorkspace> {
    let record = await this.load(id);
    if (record.status === "published") return record;
    if (path.resolve(await fs.realpath(record.sourceRoot)) !== path.resolve(record.sourceRoot)) fail("Source repository path was redirected");
    // Publication lock also serializes tasks targeting the same original checkout.
    const sourceLock = await acquireMassUlwLock({ path: path.join(this.base, `source-${digest(record.sourceRoot)}.lock`), now: Date.now, lockedMessage: "Another workspace is publishing to this source" });
    try {
      const recovery = await recoverMassUlwPublication({ recoveryRoot: this.stateDir, recoveryId: id, repositoryRoot: record.sourceRoot });
      if (recovery.kind === "committed") return this.save({ ...record, status: "published", changedPaths: [...recovery.receipt.changedPaths] });
      record = await this.assertVerified(id, verificationId);
      if (!reviewSummary.trim()) fail("A review summary for the verified changes is required");
      record = await this.save({ ...record, review: { verificationId, fingerprint: record.verification!.fingerprint, summary: reviewSummary, at: Date.now() } });
      const commit = await createSnapshotCommit(this.root(id), (await git(this.root(id), ["rev-parse", "HEAD"])).trim(), this.directory(id));
      await this.assertVerified(id, verificationId);
      const changes = await treeChanges(this.root(id), record.baselineCommit, commit);
      auditChanges(this.root(id), { id, writeScopes: changes.map((item) => item.path.toLowerCase()) }, changes);
      const result = await publishMassUlwWorkspace({ repositoryRoot: record.sourceRoot, privateRoot: this.directory(id), baselineCommit: record.baselineCommit,
        initialFingerprint: record.initialFingerprint, integration: { commit, changedPaths: changes.map((item) => item.path), laneCommits: [] },
        hooks: {}, durableTransactionRoot: publicationTransactionRoot(this.stateDir, id), onTerminal: () => undefined });
      return this.save({ ...record, status: "published", changedPaths: result.changedPaths });
    } finally { await sourceLock.release(); }
  }
}

/** Synthesized entries are rebuilt from durable state, never from directory scanning. */
export async function taskWorkspaceProjects(stateDir: string): Promise<ProjectRegistryEntry[]> {
  const store = new TaskWorkspaceStore(stateDir);
  return (await store.list()).filter((record) => record.status === "active").map((record) => store.project(record));
}

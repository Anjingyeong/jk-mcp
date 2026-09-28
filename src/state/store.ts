import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { renameWithRetry } from "../util/fs-retry.js";
import { join } from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode, type ProjectRegistryEntry } from "../types.js";
import { isTaskWorkspaceId, taskWorkspaceProjects } from "../workspace/task-workspaces.js";
import { acquireMassUlwLock } from "../orchestration/mass-ulw-lock.js";

/**
 * Central state store under `~/.local/share/jk/` (PRD §10):
 * projects.json (registry) and sessions.json (active project/mode/lease).
 *
 * Persistence rules (PRD §10, §11 SR-04/SR-08 adjacent hardening):
 *  - Directory created with mode 0700, files written with mode 0600.
 *  - Every write is atomic: write to a temp file in the same directory, then
 *    `rename()` over the target (rename is atomic on the same filesystem).
 *  - Every on-disk document is validated with zod before being handed back to
 *    callers; corrupt/foreign JSON never silently propagates.
 *  - Timestamps are integer epoch-ms.
 */

const ProjectRegistryEntrySchema = z.object({
  projectId: z.string(),
  name: z.string(),
  root: z.string(),
  aliases: z.array(z.string()),
  branch: z.string().optional(),
  dirty: z.boolean().optional(),
  hasAgentsMd: z.boolean().optional(),
  hasCodeBrain: z.boolean().optional(),
  packageHints: z.array(z.string()).optional(),
  lastSeenAt: z.string().optional(),
  executorId: z.string().optional(),
  executorKind: z.enum(["local", "remote"]).optional(),
  executorOnline: z.boolean().optional(),
  sourceProjectId: z.string().optional(),
}) satisfies z.ZodType<ProjectRegistryEntry>;

const ProjectsFileSchema = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  projects: z.array(ProjectRegistryEntrySchema),
});

type ProjectsFile = z.infer<typeof ProjectsFileSchema>;

const RecentWorkFileSchema = z.object({
  path: z.string().min(1),
  fileHash: z.string().nullable(),
  lastAction: z.enum(["read", "edit", "create", "delete", "move"]),
  lastTouchedAt: z.number().int().nonnegative(),
  start: z.number().int().min(1).optional(),
  end: z.number().int().min(1).optional(),
});

const MutationFileSchema = z.object({
  path: z.string().min(1),
  action: z.enum(["add", "update", "delete", "move", "create"]),
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
});

const LastMutationSchema = z.object({
  checkpointId: z.string().min(1),
  tool: z.enum(["file_apply_patch", "file_create"]),
  files: z.array(MutationFileSchema).max(50),
  at: z.number().int().nonnegative(),
});

const LastVerificationSchema = z.object({
  tool: z.enum(["command_run", "local_shell_run", "e2e_run_command", "e2e_test_and_show_screenshot"]),
  command: z.string().max(500),
  success: z.boolean(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  at: z.number().int().nonnegative(),
});

const TaskDecisionSchema = z.object({
  summary: z.string().min(1).max(500),
  rationale: z.string().max(1000).nullable().default(null),
  at: z.number().int().nonnegative(),
});

const TaskContinuationSchema = z.object({
  jobId: z.string().min(1),
  status: z.enum(["waiting-approval", "running", "ready-to-resume", "blocked", "denied"]),
  updatedAt: z.number().int().nonnegative(),
  deliveredAt: z.number().int().nonnegative().optional(),
  resultRevision: z.string().optional(),
  deliveryToken: z.string().optional(),
}).nullable().default(null);

const TaskSafetyStatusSchema = z.enum(["unknown", "pass", "fail", "not-required"]);
const TaskExecutionSafetySchema = z.object({
  executionKind: z.enum(["workspace", "live-runtime", "release-deploy"]).default("workspace"),
  preflightStatus: TaskSafetyStatusSchema.default("not-required"),
  preflightEvidence: z.array(z.string().min(1).max(2000)).max(30).default([]),
  executionTarget: z.object({
    machine: z.string().max(200).nullable().default(null),
    projectRoot: z.string().max(1000).nullable().default(null),
    branch: z.string().max(200).nullable().default(null),
    dirty: z.boolean().nullable().default(null),
    runtimeTarget: z.string().max(500).nullable().default(null),
  }).default({}),
  approvalPlan: z.array(z.string().min(1).max(2000)).max(20).default([]),
  rollbackStatus: TaskSafetyStatusSchema.default("not-required"),
  releaseCollisionStatus: TaskSafetyStatusSchema.default("not-required"),
  runtimeProofStatus: TaskSafetyStatusSchema.default("not-required"),
  runtimeProofEvidence: z.array(z.string().min(1).max(2000)).max(30).default([]),
  operationalDrift: z.array(z.string().min(1).max(2000)).max(30).default([]),
}).default({});

export const TaskStateSchema = z.object({
  loopRevision: z.number().int().nonnegative().optional(),
  lifecycle: z.enum(["active", "yielded", "reasoning-needed", "blocked", "succeeded"]).optional(),
  goalId: z.string().nullable().default(null),
  loopId: z.string().nullable().default(null),
  // Long-running MASS ULW goals commonly carry safety, verification and
  // release constraints that exceed a short UI preview. Preserve the full
  // bounded contract in task state so later turns/recovery lanes do not lose
  // requirements after the first 1k characters.
  currentGoal: z.string().max(12000).nullable().default(null),
  currentTask: z.string().max(500).nullable().default(null),
  lastProgressSummary: z.string().max(1000).nullable().default(null),
  completed: z.array(z.string().min(1).max(500)).max(50).default([]),
  pending: z.array(z.string().min(1).max(500)).max(50).default([]),
  decisions: z.array(TaskDecisionSchema).max(30).default([]),
  continuation: TaskContinuationSchema,
  executionSafety: TaskExecutionSafetySchema,
  updatedAt: z.number().int().nonnegative().default(0),
});

const WorkContextSchema = z.object({
  projectId: z.string(),
  workSessionId: z.string().nullable().default(null),
  activeArtifact: z.string().nullable(),
  recentFiles: z.array(RecentWorkFileSchema).max(20),
  lastCheckpointId: z.string().nullable(),
  lastMutation: LastMutationSchema.nullable().default(null),
  lastVerification: LastVerificationSchema.nullable().default(null),
  taskState: TaskStateSchema.default({}),
  lastActivityAt: z.number().int().nonnegative(),
});

/** Session document shape (active project, mode, lease, recent work context) — PRD §6, §7. */
const SessionSchema = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  activeProjectId: z.string().nullable(),
  mode: z.enum(["observe", "read", "edit", "verify", "danger"]),
  lease: z
    .object({
      projectId: z.string(),
      leaseId: z.string(),
      projectRoot: z.string(),
      preset: z.enum(["read-only", "tests-only", "full-write", "image-only", "control"]),
      issuedAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().nonnegative(),
    })
    .nullable(),
  controlAllowlist: z.array(z.string().trim().min(1).max(80)).max(32).default([]),
  // Legacy v2 single-project context. Kept readable for migration only.
  workContext: WorkContextSchema.nullable().default(null),
  workContexts: z.record(z.string(), WorkContextSchema).default({}),
  workSessions: z.record(z.string(), z.record(z.string(), WorkContextSchema)).default({}),
});

export type SessionDocument = z.infer<typeof SessionSchema>;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const PROJECTS_FILE = "projects.json";
const SESSIONS_FILE = "sessions.json";

// Serialize session read-modify-write operations per state directory. A
// module-level queue also coordinates multiple Store instances in the same
// runtime process that point at the same persisted session file.
const sessionWriteQueues = new Map<string, Promise<void>>();

function emptyProjectsFile(): ProjectsFile {
  return { version: 1, updatedAt: Date.now(), projects: [] };
}

function emptySession(): SessionDocument {
  return {
    version: 5,
    updatedAt: Date.now(),
    activeProjectId: null,
    mode: "observe",
    lease: null,
    controlAllowlist: [],
    workContext: null,
    workContexts: {},
    workSessions: {},
  };
}

export class Store {
  private readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  /** Ensure the state directory exists with restrictive 0700 permissions. */
  private async ensureStateDir(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
    // mkdir with an existing dir does not retroactively chmod; best-effort
    // tighten permissions in case the directory pre-existed with a laxer mode.
    try {
      const { chmod } = await import("node:fs/promises");
      await chmod(this.stateDir, DIR_MODE);
    } catch {
      // Non-fatal: directory may be on a filesystem without POSIX perms.
    }
  }

  /**
   * Atomically write `data` (already JSON-stringified) to `filename` inside
   * the state dir: write to a sibling temp file, fsync-flush via the OS
   * write, then rename over the target. Rename is atomic within the same
   * directory/filesystem, so readers never observe a partial write.
   */
  private async atomicWriteJson(filename: string, data: unknown): Promise<void> {
    await this.ensureStateDir();
    const target = join(this.stateDir, filename);
    const tmp = join(
      this.stateDir,
      `.${filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const json = JSON.stringify(data, null, 2);
    const handle = await open(tmp, "wx", FILE_MODE);
    try {
      try { await handle.writeFile(json, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await renameWithRetry(tmp, target);
    } finally {
      await unlink(tmp).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
    }
  }

  /** Loop checkpoint authority; caller validates owner and payload under lockedGoalLoop. */
  async writeGoalLoop(loopId: string, payload: Record<string, unknown>): Promise<void> {
    z.string().regex(/^[A-Za-z0-9_.-]+$/).max(200).parse(loopId);
    await new Store(join(this.stateDir, "goals")).atomicWriteJson(loopId + ".loop.json", payload);
  }

  async lockedGoalLoop<T>(loopId: string, action: () => Promise<T>): Promise<T> {
    z.string().regex(/^[A-Za-z0-9_.-]+$/).max(200).parse(loopId);
    const goals = join(this.stateDir, "goals");
    await mkdir(goals, { recursive: true, mode: DIR_MODE });
    return this.enqueueSessionWrite(async () => {
      const lock = await acquireMassUlwLock({ path: join(goals, loopId + ".lock"), now: Date.now,
        lockedMessage: "Goal loop is busy in another process; retry without replacing its owner" });
      try { return await action(); } finally { await lock.release(); }
    }, join(goals, loopId));
  }

  private async readJson(filename: string): Promise<unknown | undefined> {
    const target = join(this.stateDir, filename);
    try {
      const raw = await readFile(target, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        `Store: failed to read/parse ${filename}: ${(err as Error).message}`,
      );
    }
  }

  async loadProjects(): Promise<ProjectRegistryEntry[]> {
    const raw = await this.readJson(PROJECTS_FILE);
    if (raw === undefined) return taskWorkspaceProjects(this.stateDir);
    const parsed = ProjectsFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        `Store: ${PROJECTS_FILE} failed validation: ${parsed.error.message}`,
      );
    }
    return [...parsed.data.projects.filter((entry) => !isTaskWorkspaceId(entry.projectId)), ...await taskWorkspaceProjects(this.stateDir)];
  }

  async saveProjects(p: ProjectRegistryEntry[]): Promise<void> {
    const validated = z.array(ProjectRegistryEntrySchema).parse(p.filter((entry) => !isTaskWorkspaceId(entry.projectId)));
    const doc: ProjectsFile = {
      version: 1,
      updatedAt: Date.now(),
      projects: validated,
    };
    await this.atomicWriteJson(PROJECTS_FILE, doc);
  }

  async getSession(): Promise<SessionDocument> {
    const raw = await this.readJson(SESSIONS_FILE);
    if (raw === undefined) return emptySession();
    const parsed = SessionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        `Store: ${SESSIONS_FILE} failed validation: ${parsed.error.message}`,
      );
    }
    const session = parsed.data;
    if (session.workContext && Object.keys(session.workContexts).length === 0) {
      return {
        ...session,
        workContexts: { [session.workContext.projectId]: session.workContext },
      };
    }
    return session;
  }

  private normalizeSession(s: unknown): SessionDocument {
    const merged = {
      ...emptySession(),
      ...(typeof s === "object" && s !== null ? s : {}),
    };
    // Writes always migrate the persisted session to the latest schema version.
    // If a v2 caller still supplies the old single workContext, preserve it in
    // the per-project map before clearing the legacy field.
    if (merged.workContext && Object.keys(merged.workContexts).length === 0) {
      merged.workContexts = { [merged.workContext.projectId]: merged.workContext };
    }
    merged.workContext = null;
    merged.version = 5;
    // updatedAt is always server-recomputed, never trusted from caller input.
    merged.updatedAt = Date.now();
    return SessionSchema.parse(merged);
  }

  private async writeSessionNow(s: unknown): Promise<SessionDocument> {
    const validated = this.normalizeSession(s);
    await this.atomicWriteJson(SESSIONS_FILE, validated);
    return validated;
  }

  private enqueueSessionWrite<T>(operation: () => Promise<T>, key = this.stateDir): Promise<T> {
    const previous = sessionWriteQueues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    sessionWriteQueues.set(key, tail);
    void tail.then(() => {
      if (sessionWriteQueues.get(key) === tail) {
        sessionWriteQueues.delete(key);
      }
    });
    return run;
  }

  async setSession(s: unknown): Promise<void> {
    await this.enqueueSessionWrite(async () => {
      await this.writeSessionNow(s);
    });
  }

  async updateSession(
    mutator: (current: SessionDocument) => unknown | Promise<unknown>,
  ): Promise<SessionDocument> {
    return this.enqueueSessionWrite(async () => {
      const current = await this.getSession();
      const next = await mutator(current);
      return this.writeSessionNow(next);
    });
  }
}

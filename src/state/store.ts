import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode, type ProjectRegistryEntry } from "../types.js";

/**
 * Central state store under `~/.local/share/chatgpt2codex/` (PRD §10):
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
}).nullable().default(null);

const TaskStateSchema = z.object({
  goalId: z.string().nullable().default(null),
  loopId: z.string().nullable().default(null),
  currentGoal: z.string().max(1000).nullable().default(null),
  currentTask: z.string().max(500).nullable().default(null),
  lastProgressSummary: z.string().max(1000).nullable().default(null),
  completed: z.array(z.string().min(1).max(500)).max(50).default([]),
  pending: z.array(z.string().min(1).max(500)).max(50).default([]),
  decisions: z.array(TaskDecisionSchema).max(30).default([]),
  continuation: TaskContinuationSchema,
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
      preset: z.enum(["read-only", "tests-only", "full-write", "image-only"]),
      issuedAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().nonnegative(),
    })
    .nullable(),
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
    await writeFile(tmp, json, { mode: FILE_MODE, encoding: "utf8" });
    await rename(tmp, target);
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
    if (raw === undefined) return [];
    const parsed = ProjectsFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        `Store: ${PROJECTS_FILE} failed validation: ${parsed.error.message}`,
      );
    }
    return parsed.data.projects;
  }

  async saveProjects(p: ProjectRegistryEntry[]): Promise<void> {
    const validated = z.array(ProjectRegistryEntrySchema).parse(p);
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

  private enqueueSessionWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = sessionWriteQueues.get(this.stateDir) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    sessionWriteQueues.set(this.stateDir, tail);
    void tail.then(() => {
      if (sessionWriteQueues.get(this.stateDir) === tail) {
        sessionWriteQueues.delete(this.stateDir);
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

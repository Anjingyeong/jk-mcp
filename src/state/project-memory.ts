import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MEMORY_FILE = "project-memory.json";
const MAX_CONTEXT_PACKS = 24;
const MAX_RESULTS = 80;
const MAX_KNOWN_FIXES = 100;

const ContextPackEntrySchema = z.object({
  key: z.string().min(1),
  fingerprint: z.string().min(1),
  topic: z.string().max(500),
  bundle: z.string().max(100_000),
  files: z.array(z.object({ path: z.string(), reason: z.string().max(500) })).max(30),
  truncated: z.boolean(),
  bytesUsed: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
});

const ResultCacheEntrySchema = z.object({
  key: z.string().min(1),
  task: z.string().max(1000),
  role: z.string().max(200).nullable(),
  fingerprint: z.string().min(1),
  value: z.string().max(30_000),
  createdAt: z.number().int().nonnegative(),
});

const KnownFixSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  symptom: z.string().min(1).max(1500),
  solution: z.string().min(1).max(5000),
  tags: z.array(z.string().min(1).max(80)).max(20),
  files: z.array(z.string().min(1).max(500)).max(20),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

const ProjectMemorySchema = z.object({
  contextPacks: z.array(ContextPackEntrySchema).default([]),
  results: z.array(ResultCacheEntrySchema).default([]),
  knownFixes: z.array(KnownFixSchema).default([]),
});

const MemoryFileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.number().int().nonnegative(),
  projects: z.record(z.string(), ProjectMemorySchema).default({}),
});

type ContextPackEntry = z.infer<typeof ContextPackEntrySchema>;
type ResultCacheEntry = z.infer<typeof ResultCacheEntrySchema>;
export type KnownFix = z.infer<typeof KnownFixSchema>;
type MemoryFile = z.infer<typeof MemoryFileSchema>;

const writeQueues = new Map<string, Promise<void>>();

function emptyMemory(): MemoryFile {
  return { version: 1, updatedAt: Date.now(), projects: {} };
}

function projectMemory(doc: MemoryFile, projectId: string): z.infer<typeof ProjectMemorySchema> {
  return doc.projects[projectId] ?? { contextPacks: [], results: [], knownFixes: [] };
}

function trimNewest<T extends { createdAt: number }>(items: T[], max: number): T[] {
  return [...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, max);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokens(value: string): string[] {
  return normalizeText(value)
    .split(/[^\p{L}\p{N}_./:-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

export async function fingerprintFiles(root: string, files: string[]): Promise<string> {
  const normalized = Array.from(new Set(files.map((file) => file.replace(/\\/g, "/")))).sort();
  const parts: string[] = [];
  for (const rel of normalized) {
    const abs = path.resolve(root, rel);
    if (!isInsideRoot(root, abs)) {
      parts.push(`${rel}:outside-root`);
      continue;
    }
    try {
      const info = await stat(abs);
      parts.push(`${rel}:${info.size}:${Math.trunc(info.mtimeMs)}`);
    } catch {
      parts.push(`${rel}:missing`);
    }
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

async function gitProjectFingerprint(root: string): Promise<{ fingerprint: string; revision: string | null; dirty: boolean }> {
  try {
    const [headResult, statusResult] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 3000, maxBuffer: 512 * 1024 }),
      execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
        cwd: root,
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
      }),
    ]);
    const revision = String(headResult.stdout).trim() || null;
    const statusRaw = String(statusResult.stdout);
    const dirtyPaths: string[] = [];
    const records = statusRaw.split("\0").filter(Boolean);
    for (const record of records) {
      if (record.length < 4) continue;
      const rel = record.slice(3).trim();
      if (rel) dirtyPaths.push(rel);
    }
    const dirtyFingerprint = await fingerprintFiles(root, dirtyPaths);
    const fingerprint = createHash("sha256")
      .update(`${revision ?? "no-head"}\n${statusRaw}\n${dirtyFingerprint}`)
      .digest("hex");
    return { fingerprint, revision, dirty: statusRaw.length > 0 };
  } catch {
    const fallbackFiles = ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "pyproject.toml", "requirements.txt"];
    const fallback = await fingerprintFiles(root, fallbackFiles);
    const rootInfo = await stat(root).catch(() => null);
    const fingerprint = createHash("sha256")
      .update(`${fallback}:${rootInfo ? `${rootInfo.size}:${Math.trunc(rootInfo.mtimeMs)}` : "missing-root"}`)
      .digest("hex");
    return { fingerprint, revision: null, dirty: false };
  }
}

export async function fingerprintProject(root: string, files?: string[]): Promise<{ fingerprint: string; revision: string | null; dirty: boolean }> {
  if (files && files.length > 0) {
    return { fingerprint: await fingerprintFiles(root, files), revision: null, dirty: false };
  }
  return gitProjectFingerprint(root);
}

export function resultCacheKey(task: string, role: string | null, fingerprint: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ task: normalizeText(task), role: normalizeText(role ?? ""), fingerprint }))
    .digest("hex");
}

export function contextPackCacheKey(topic: string, files: string[], maxBytes: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ topic: normalizeText(topic), files: [...files].sort(), maxBytes }))
    .digest("hex");
}

export class ProjectMemoryStore {
  constructor(private readonly stateDir: string) {}

  private async ensureDir(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
  }

  private async read(): Promise<MemoryFile> {
    const target = path.join(this.stateDir, MEMORY_FILE);
    try {
      const raw = JSON.parse(await readFile(target, "utf8"));
      const parsed = MemoryFileSchema.safeParse(raw);
      return parsed.success ? parsed.data : emptyMemory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyMemory();
      return emptyMemory();
    }
  }

  private async write(doc: MemoryFile): Promise<void> {
    await this.ensureDir();
    const target = path.join(this.stateDir, MEMORY_FILE);
    const tmp = path.join(this.stateDir, `.${MEMORY_FILE}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`);
    const validated = MemoryFileSchema.parse({ ...doc, version: 1, updatedAt: Date.now() });
    await writeFile(tmp, JSON.stringify(validated, null, 2), { encoding: "utf8", mode: FILE_MODE });
    await rename(tmp, target);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = writeQueues.get(this.stateDir) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    writeQueues.set(this.stateDir, tail);
    void tail.then(() => {
      if (writeQueues.get(this.stateDir) === tail) writeQueues.delete(this.stateDir);
    });
    return run;
  }

  async getContextPack(projectId: string, key: string, fingerprint: string): Promise<ContextPackEntry | null> {
    const doc = await this.read();
    return projectMemory(doc, projectId).contextPacks.find((item) => item.key === key && item.fingerprint === fingerprint) ?? null;
  }

  async putContextPack(projectId: string, entry: Omit<ContextPackEntry, "createdAt">): Promise<void> {
    await this.enqueue(async () => {
      const doc = await this.read();
      const current = projectMemory(doc, projectId);
      const next: ContextPackEntry = { ...entry, createdAt: Date.now() };
      current.contextPacks = trimNewest([next, ...current.contextPacks.filter((item) => item.key !== entry.key)], MAX_CONTEXT_PACKS);
      doc.projects[projectId] = current;
      await this.write(doc);
    });
  }

  async getResult(projectId: string, key: string): Promise<ResultCacheEntry | null> {
    const doc = await this.read();
    return projectMemory(doc, projectId).results.find((item) => item.key === key) ?? null;
  }

  async putResult(projectId: string, entry: Omit<ResultCacheEntry, "createdAt">): Promise<void> {
    await this.enqueue(async () => {
      const doc = await this.read();
      const current = projectMemory(doc, projectId);
      const next: ResultCacheEntry = { ...entry, createdAt: Date.now() };
      current.results = trimNewest([next, ...current.results.filter((item) => item.key !== entry.key)], MAX_RESULTS);
      doc.projects[projectId] = current;
      await this.write(doc);
    });
  }

  async addKnownFix(projectId: string, input: { title: string; symptom: string; solution: string; tags?: string[]; files?: string[] }): Promise<KnownFix> {
    return this.enqueue(async () => {
      const doc = await this.read();
      const current = projectMemory(doc, projectId);
      const now = Date.now();
      const dedupeKey = `${normalizeText(input.title)}\n${normalizeText(input.symptom)}`;
      const existing = current.knownFixes.find(
        (fix) => `${normalizeText(fix.title)}\n${normalizeText(fix.symptom)}` === dedupeKey,
      );
      const next: KnownFix = existing
        ? {
            ...existing,
            solution: input.solution,
            tags: Array.from(new Set(input.tags ?? existing.tags)).slice(0, 20),
            files: Array.from(new Set(input.files ?? existing.files)).slice(0, 20),
            updatedAt: now,
          }
        : {
            id: `fix_${randomUUID()}`,
            title: input.title,
            symptom: input.symptom,
            solution: input.solution,
            tags: Array.from(new Set(input.tags ?? [])).slice(0, 20),
            files: Array.from(new Set(input.files ?? [])).slice(0, 20),
            createdAt: now,
            updatedAt: now,
          };
      current.knownFixes = [next, ...current.knownFixes.filter((fix) => fix.id !== next.id)]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_KNOWN_FIXES);
      doc.projects[projectId] = current;
      await this.write(doc);
      return next;
    });
  }

  async searchKnownFixes(projectId: string, query: string, maxResults = 5): Promise<Array<KnownFix & { score: number }>> {
    const doc = await this.read();
    const q = normalizeText(query);
    const queryTokens = tokens(query);
    return projectMemory(doc, projectId).knownFixes
      .map((fix) => {
        const title = normalizeText(fix.title);
        const symptom = normalizeText(fix.symptom);
        const solution = normalizeText(fix.solution);
        const tags = fix.tags.map(normalizeText);
        const files = fix.files.map(normalizeText);
        let score = 0;
        if (q && title.includes(q)) score += 12;
        if (q && symptom.includes(q)) score += 9;
        if (q && solution.includes(q)) score += 4;
        for (const token of queryTokens) {
          if (title.includes(token)) score += 5;
          if (symptom.includes(token)) score += 4;
          if (solution.includes(token)) score += 2;
          if (tags.some((tag) => tag.includes(token))) score += 4;
          if (files.some((file) => file.includes(token))) score += 2;
        }
        return { ...fix, score };
      })
      .filter((fix) => fix.score > 0 || q.length === 0)
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(maxResults, 20)));
  }
}

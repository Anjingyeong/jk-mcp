import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_GOAL_LOOP_INPUT_FIELDS = ["safety", "executionProfile", "fanoutCandidates"] as const;

export interface RuntimeSchemaManifest {
  version: 1;
  generatedAt: string;
  sourceFiles: string[];
  buildFiles: string[];
  sourceFingerprint: string;
  buildFingerprint: string;
  requiredGoalLoopInputFields: string[];
}

export interface RegisteredToolSchemaHealth {
  toolSchemaFingerprint: string | null;
  registeredToolNames: string[];
  goalLoopInputFields: string[];
  missingGoalLoopInputFields: string[];
  toolSchemaCompatible: boolean;
}

export interface RuntimeSchemaHealth extends RegisteredToolSchemaHealth {
  status: "ok" | "mismatch" | "unverified";
  releaseBlocked: boolean;
  reasons: string[];
  manifestPath: string | null;
  sourceRoot: string | null;
  sourceFingerprint: string | null;
  expectedSourceFingerprint: string | null;
  buildFingerprint: string | null;
  expectedBuildFingerprint: string | null;
}

let registeredSchemaHealth: RegisteredToolSchemaHealth = {
  toolSchemaFingerprint: null,
  registeredToolNames: [],
  goalLoopInputFields: [],
  missingGoalLoopInputFields: [...REQUIRED_GOAL_LOOP_INPUT_FIELDS],
  toolSchemaCompatible: false,
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintJson(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function recordRegisteredToolSchemas(
  tools: Array<{ name: string; inputSchema?: unknown }>,
): RegisteredToolSchemaHealth {
  const normalized = tools
    .map((tool) => ({ name: tool.name, inputSchema: canonicalize(tool.inputSchema ?? {}) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const goalLoop = normalized.find((tool) => tool.name === "goal_loop");
  const schema = goalLoop?.inputSchema;
  const properties = schema && typeof schema === "object" && !Array.isArray(schema)
    ? (schema as Record<string, unknown>).properties
    : null;
  const goalLoopInputFields = properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties as Record<string, unknown>).sort()
    : [];
  const missingGoalLoopInputFields = REQUIRED_GOAL_LOOP_INPUT_FIELDS.filter(
    (field) => !goalLoopInputFields.includes(field),
  );
  registeredSchemaHealth = {
    toolSchemaFingerprint: fingerprintJson(normalized),
    registeredToolNames: normalized.map((tool) => tool.name),
    goalLoopInputFields,
    missingGoalLoopInputFields,
    toolSchemaCompatible: missingGoalLoopInputFields.length === 0,
  };
  return {
    ...registeredSchemaHealth,
    registeredToolNames: [...registeredSchemaHealth.registeredToolNames],
    goalLoopInputFields: [...goalLoopInputFields],
    missingGoalLoopInputFields: [...missingGoalLoopInputFields],
  };
}

export function getRegisteredToolSchemaHealth(): RegisteredToolSchemaHealth {
  return {
    ...registeredSchemaHealth,
    registeredToolNames: [...registeredSchemaHealth.registeredToolNames],
    goalLoopInputFields: [...registeredSchemaHealth.goalLoopInputFields],
    missingGoalLoopInputFields: [...registeredSchemaHealth.missingGoalLoopInputFields],
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function fingerprintFiles(root: string, files: string[]): Promise<string | null> {
  try {
    const entries: string[] = [];
    for (const relative of files) {
      const absolute = path.join(root, relative);
      const bytes = await readFile(absolute);
      entries.push(`${relative.replace(/\\/g, "/")}:${sha256(bytes)}`);
    }
    return sha256(entries.join("\n"));
  } catch {
    return null;
  }
}

function ancestors(start: string): string[] {
  const result: string[] = [];
  let current = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

async function findSourceRoot(): Promise<string | null> {
  const candidates = new Set<string>();
  if (process.env.JK_SOURCE_ROOT) candidates.add(path.resolve(process.env.JK_SOURCE_ROOT));
  candidates.add(path.resolve(process.cwd()));
  if (process.env.JK_RUNTIME_ROOT) {
    for (const candidate of ancestors(process.env.JK_RUNTIME_ROOT)) candidates.add(candidate);
  }
  for (const candidate of candidates) {
    if (
      await exists(path.join(candidate, "src", "server", "tools.ts")) &&
      await exists(path.join(candidate, "src", "server", "actions.ts"))
    ) return candidate;
  }
  return null;
}

async function findManifest(): Promise<{ manifest: RuntimeSchemaManifest; path: string; distRoot: string } | null> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "..", "runtime-schema-manifest.json"),
    ...(process.env.JK_RUNTIME_ROOT
      ? [
          path.join(path.resolve(process.env.JK_RUNTIME_ROOT), "dist", "runtime-schema-manifest.json"),
          path.join(path.resolve(process.env.JK_RUNTIME_ROOT), "runtime-schema-manifest.json"),
        ]
      : []),
    path.join(process.cwd(), "dist", "runtime-schema-manifest.json"),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as RuntimeSchemaManifest;
      if (parsed.version !== 1 || !Array.isArray(parsed.sourceFiles) || !Array.isArray(parsed.buildFiles)) continue;
      const parent = path.dirname(candidate);
      const distRoot = path.basename(parent).toLowerCase() === "dist" ? parent : path.join(parent, "dist");
      return { manifest: parsed, path: candidate, distRoot };
    } catch {
      // Try the next manifest candidate.
    }
  }
  return null;
}

export async function getRuntimeSchemaHealth(): Promise<RuntimeSchemaHealth> {
  const registered = getRegisteredToolSchemaHealth();
  const reasons: string[] = [];
  const manifestInfo = await findManifest();
  const sourceRoot = await findSourceRoot();

  const currentSourceFingerprint = sourceRoot && manifestInfo
    ? await fingerprintFiles(sourceRoot, manifestInfo.manifest.sourceFiles)
    : null;
  const currentBuildFingerprint = manifestInfo
    ? await fingerprintFiles(manifestInfo.distRoot, manifestInfo.manifest.buildFiles)
    : null;

  // A fresh HTTP runtime may not have constructed an MCP server yet, so the
  // in-memory tools/list cache can legitimately be empty during bootstrap.
  // Only treat the registered schema as stale after a real catalog has been
  // observed and fingerprinted.
  if (registered.toolSchemaFingerprint && !registered.toolSchemaCompatible) {
    reasons.push(`registered goal_loop schema missing: ${registered.missingGoalLoopInputFields.join(", ")}`);
  }
  if (manifestInfo && currentBuildFingerprint && currentBuildFingerprint !== manifestInfo.manifest.buildFingerprint) {
    reasons.push("running build files do not match the build manifest fingerprint");
  }
  if (manifestInfo && sourceRoot && currentSourceFingerprint && currentSourceFingerprint !== manifestInfo.manifest.sourceFingerprint) {
    reasons.push("source schema files changed after this runtime build was produced");
  }

  const mismatch = reasons.length > 0;
  const verifiable = Boolean(manifestInfo) || Boolean(registered.toolSchemaFingerprint);
  return {
    ...registered,
    status: mismatch ? "mismatch" : verifiable ? "ok" : "unverified",
    releaseBlocked: mismatch,
    reasons,
    manifestPath: manifestInfo?.path ?? null,
    sourceRoot,
    sourceFingerprint: currentSourceFingerprint,
    expectedSourceFingerprint: manifestInfo?.manifest.sourceFingerprint ?? null,
    buildFingerprint: currentBuildFingerprint,
    expectedBuildFingerprint: manifestInfo?.manifest.buildFingerprint ?? null,
  };
}

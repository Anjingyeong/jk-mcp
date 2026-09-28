import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const REQUIRED_GOAL_LOOP_INPUT_FIELDS = ["safety", "executionProfile", "fanoutCandidates", "reviewVerdict"] as const;

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
  startupBuildFingerprint: string | null;
  startupExpectedBuildFingerprint: string | null;
  startupManifestFingerprint: string | null;
  currentManifestFingerprint: string | null;
  startupCapturedAt: string;
}

const requiredModules = [
  "server/tools", "server/actions", "server/runtime-schema-health", "control-center/http",
  "policy/local-approvals", "policy/approvals", "policy/local-approval-bundles",
  "policy/local-shell-jobs", "orchestration/mass-ulw-lock",
] as const;
const manifestFiles = z.array(z.string().regex(/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[a-zA-Z0-9_./-]+$/u))
  .nonempty().refine((files) => files.every((file) => !file.startsWith("/") && !file.includes("//")) && new Set(files).size === files.length);
const manifestSchema = z.object({
  version: z.literal(1), generatedAt: z.string().datetime(),
  sourceFiles: manifestFiles.refine((files) => requiredModules.every((file) => files.includes(`src/${file}.ts`))),
  buildFiles: manifestFiles.refine((files) => requiredModules.every((file) => files.includes(`${file}.js`))),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  buildFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  requiredGoalLoopInputFields: z.array(z.string()).refine((fields) =>
    REQUIRED_GOAL_LOOP_INPUT_FIELDS.every((field) => fields.includes(field)) && new Set(fields).size === fields.length),
});

async function readManifest(file: string) {
  let fingerprint: string | null = null;
  try {
    const bytes = await readFile(file);
    fingerprint = sha256(bytes);
    const parsed = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    const manifest = Object.freeze({ ...parsed,
      sourceFiles: Object.freeze([...parsed.sourceFiles]), buildFiles: Object.freeze([...parsed.buildFiles]),
      requiredGoalLoopInputFields: Object.freeze([...parsed.requiredGoalLoopInputFields]),
    });
    return { manifest, fingerprint, missing: false, error: null };
  } catch (error) {
    return { manifest: null, fingerprint,
      missing: error instanceof Error && "code" in error && error.code === "ENOENT",
      error: `manifest evidence unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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

async function fingerprintFiles(root: string, files: readonly string[]): Promise<string | null> {
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

async function findManifest() {
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
    const evidence = await readManifest(candidate);
    if (evidence.missing) continue;
    const parent = path.dirname(candidate);
    const distRoot = path.basename(parent).toLowerCase() === "dist" ? parent : path.join(parent, "dist");
    // A present but invalid higher-priority manifest must not be hidden by a fallback.
    return { ...evidence, path: candidate, distRoot };
  }
  return null;
}

async function readFingerprints(info: Awaited<ReturnType<typeof findManifest>>, sourceRoot: string | null) {
  const [sourceFingerprint, buildFingerprint] = await Promise.all([
    info?.manifest && sourceRoot ? fingerprintFiles(sourceRoot, info.manifest.sourceFiles) : null,
    info?.manifest ? fingerprintFiles(info.distRoot, info.manifest.buildFiles) : null,
  ]);
  return { sourceFingerprint, buildFingerprint };
}

// Attests bytes observed during module startup, not loaded functions or external
// dependencies. Await before import completes, even when no health request occurs.
const startup = await (async () => {
  const capturedAt = new Date().toISOString();
  const info = await findManifest();
  const sourceRoot = await findSourceRoot();
  return Object.freeze({ capturedAt, info: info ? Object.freeze(info) : null, sourceRoot,
    ...await readFingerprints(info, sourceRoot) });
})();

export async function getRuntimeSchemaHealth(): Promise<RuntimeSchemaHealth> {
  const registered = getRegisteredToolSchemaHealth();
  const reasons: string[] = [];
  const manifestInfo = startup.info
    ? { ...startup.info, ...await readManifest(startup.info.path) }
    : null;
  const sourceRoot = startup.sourceRoot;
  const { sourceFingerprint: currentSourceFingerprint, buildFingerprint: currentBuildFingerprint } =
    await readFingerprints(manifestInfo, sourceRoot);
  const verifiable = Boolean(startup.info?.manifest && startup.buildFingerprint &&
    (!sourceRoot || startup.sourceFingerprint) && manifestInfo?.manifest && currentBuildFingerprint &&
    (!sourceRoot || currentSourceFingerprint));

  // A fresh HTTP runtime may not have constructed an MCP server yet, so the
  // in-memory tools/list cache can legitimately be empty during bootstrap.
  // Only treat the registered schema as stale after a real catalog has been
  // observed and fingerprinted.
  if (registered.toolSchemaFingerprint && !registered.toolSchemaCompatible) {
    reasons.push(`registered goal_loop schema missing: ${registered.missingGoalLoopInputFields.join(", ")}`);
  }
  if (manifestInfo?.manifest && currentBuildFingerprint && currentBuildFingerprint !== manifestInfo.manifest.buildFingerprint) {
    reasons.push("current build files do not match the build manifest fingerprint");
  }
  if (manifestInfo?.manifest && currentSourceFingerprint && currentSourceFingerprint !== manifestInfo.manifest.sourceFingerprint) {
    reasons.push("source schema files changed after this runtime build was produced");
  }
  if (startup.info?.manifest && (
    (startup.buildFingerprint && startup.buildFingerprint !== startup.info.manifest.buildFingerprint) ||
    (startup.sourceFingerprint && startup.sourceFingerprint !== startup.info.manifest.sourceFingerprint)
  )) reasons.push("startup files did not match the startup manifest");
  if (startup.info && manifestInfo && (
    startup.info.fingerprint !== manifestInfo.fingerprint || startup.buildFingerprint !== currentBuildFingerprint ||
    startup.sourceFingerprint !== currentSourceFingerprint
  )) reasons.push("runtime evidence changed since module startup; controlled reload required");

  const mismatch = reasons.length > 0;
  if (!verifiable) reasons.push(startup.info?.error ?? manifestInfo?.error ?? "startup or current file evidence is incomplete");
  return {
    ...registered,
    status: !verifiable ? "unverified" : mismatch ? "mismatch" : "ok",
    releaseBlocked: !verifiable || mismatch,
    reasons,
    manifestPath: manifestInfo?.path ?? null,
    sourceRoot,
    sourceFingerprint: currentSourceFingerprint,
    expectedSourceFingerprint: manifestInfo?.manifest?.sourceFingerprint ?? null,
    buildFingerprint: currentBuildFingerprint,
    expectedBuildFingerprint: manifestInfo?.manifest?.buildFingerprint ?? null,
    startupBuildFingerprint: startup.buildFingerprint,
    startupExpectedBuildFingerprint: startup.info?.manifest?.buildFingerprint ?? null,
    startupManifestFingerprint: startup.info?.fingerprint ?? null,
    currentManifestFingerprint: manifestInfo?.fingerprint ?? null,
    startupCapturedAt: startup.capturedAt,
  };
}

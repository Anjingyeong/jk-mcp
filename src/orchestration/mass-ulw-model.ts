import { createHash } from "node:crypto";
import { z } from "zod";

export type MassUlwExecutionProfile = "auto" | "fast" | "max";
export type MassUlwCandidate = { id: string; task: string; estimatedWeight?: number; readScopes?: string[]; writeScopes?: string[]; dependsOn?: string[]; exclusiveResources?: string[]; latencyBound?: boolean };
export type MassUlwLane = { id: string; task: string; estimatedWeight: number; readScopes: string[]; writeScopes: string[]; dependsOn: string[]; exclusiveResources: string[]; latencyBound: boolean };
export type MassUlwPlan = { state: "fanout" | "sequential"; recommended: boolean; maxLanes: number; candidateCount: number; serialWork: number; criticalPathWork: number; coordinationCost: number; latencyBonus: number; coverageBonus: number; readParallelBonus: number; contextPollutionCost: number; threshold: number; netGain: number; hardBlocks: string[]; waves: string[][]; planFingerprint: string; lanes: MassUlwLane[]; rationale: string };

const PORTABLE_LANE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const WINDOWS_RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/iu;

export function isPortableMassUlwLaneId(value: string): boolean {
  const stem = value.split(".", 1)[0] ?? "";
  return PORTABLE_LANE_ID_PATTERN.test(value) && !value.endsWith(".") && !WINDOWS_RESERVED_NAMES.test(stem);
}

export function canonicalMassUlwPlanFingerprint(lanes: readonly MassUlwLane[]): string {
  const canonical = [...lanes]
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .map((lane) => ({
      ...lane,
      readScopes: [...lane.readScopes].sort(),
      writeScopes: [...lane.writeScopes].sort(),
      dependsOn: [...lane.dependsOn].sort(),
      exclusiveResources: [...lane.exclusiveResources].sort(),
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const CandidateSchema = z.object({
  id: z.string().trim().min(1).max(80), task: z.string().trim().min(1).max(500),
  estimatedWeight: z.number().int().min(1).max(5).optional(), readScopes: z.array(z.string().min(1).max(300)).max(20).optional(),
  writeScopes: z.array(z.string().min(1).max(300)).max(20).optional(), dependsOn: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  exclusiveResources: z.array(z.string().min(1).max(120)).max(10).optional(), latencyBound: z.boolean().optional(),
}).strict();
const CandidatesSchema = z.array(CandidateSchema).max(4);
export function parseMassUlwCandidates(value: unknown): MassUlwCandidate[] { return CandidatesSchema.parse(value); }

export function normalizeFanoutScope(value: string): string {
  const scope = value.trim().replace(/\\/gu, "/");
  if (!scope || scope.includes("\0") || /[\u0000-\u001f\u007f]/u.test(scope) || scope.startsWith("/") || scope.startsWith("~") || /^[a-z]:($|\/)/iu.test(scope) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(scope)) throw new Error(`Unsafe Mass ULW scope: ${value}`);
  const segments = scope.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === ".." || segment.includes(":"))) throw new Error(`Unsafe Mass ULW scope: ${value}`);
  return segments.join("/").toLowerCase();
}
export function fanoutScopesOverlap(left: string, right: string): boolean {
  const a = normalizeFanoutScope(left); const b = normalizeFanoutScope(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

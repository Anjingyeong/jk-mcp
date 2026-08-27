import { canonicalMassUlwPlanFingerprint, fanoutScopesOverlap, isPortableMassUlwLaneId, normalizeFanoutScope } from "./mass-ulw-model.js";
import type { MassUlwCandidate, MassUlwExecutionProfile, MassUlwLane, MassUlwPlan } from "./mass-ulw-model.js";

export { fanoutScopesOverlap, normalizeFanoutScope, parseMassUlwCandidates } from "./mass-ulw-model.js";
export type { MassUlwCandidate, MassUlwExecutionProfile, MassUlwLane, MassUlwPlan } from "./mass-ulw-model.js";

function normalizeList(values: string[] | undefined, onUnsafe: () => void): string[] {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    try {
      normalized.add(normalizeFanoutScope(value));
    } catch {
      onUnsafe();
    }
  }
  return [...normalized].sort();
}

function candidateWeight(candidate: MassUlwCandidate): number {
  const weight = candidate.estimatedWeight ?? 1;
  return Number.isFinite(weight) ? Math.min(5, Math.max(1, Math.round(weight))) : 1;
}


export function buildMassUlwPlan(input: {
  executionProfile: MassUlwExecutionProfile;
  candidates: MassUlwCandidate[];
}): MassUlwPlan {
  const maxLanes = 4;
  const hardBlocks: string[] = [];
  if (input.candidates.length < 2) hardBlocks.push("fewer-than-two-lanes");
  if (input.candidates.length > maxLanes) hardBlocks.push(`lane-count-exceeds-${maxLanes}`);

  const lanes: MassUlwLane[] = input.candidates.map((candidate) => {
    const id = candidate.id.trim();
    const readScopes = normalizeList(candidate.readScopes, () => hardBlocks.push(`unsafe-scope:${id}:read`));
    const writeScopes = normalizeList(candidate.writeScopes, () => hardBlocks.push(`unsafe-scope:${id}:write`));
    const exclusiveResources = normalizeList(
      candidate.exclusiveResources,
      () => hardBlocks.push(`unsafe-resource:${id}`),
    );
    return {
      id,
      task: candidate.task.trim(),
      estimatedWeight: candidateWeight(candidate),
      readScopes,
      writeScopes,
      dependsOn: [...new Set((candidate.dependsOn ?? []).map((dependency) => dependency.trim()))].sort(),
      exclusiveResources,
      latencyBound: candidate.latencyBound ?? false,
    };
  });

  for (const lane of lanes) {
    if (!isPortableMassUlwLaneId(lane.id)) hardBlocks.push(`non-portable-lane-id:${lane.id}`);
  }
  const ids = new Set(lanes.map((lane) => lane.id));
  const caseFoldedIds = new Set(lanes.map((lane) => lane.id.toLowerCase()));
  if (caseFoldedIds.size !== lanes.length) hardBlocks.push("duplicate-lane-id");
  for (const lane of lanes) {
    for (const dependency of lane.dependsOn) {
      if (dependency === lane.id) hardBlocks.push(`self-dependency:${lane.id}`);
      else if (!ids.has(dependency)) hardBlocks.push(`unknown-dependency:${lane.id}->${dependency}`);
    }
  }

  const uniqueLanes = new Map<string, MassUlwLane>();
  for (const lane of lanes) if (!uniqueLanes.has(lane.id)) uniqueLanes.set(lane.id, lane);
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of uniqueLanes.keys()) {
    indegree.set(id, 0);
    children.set(id, []);
  }
  for (const lane of uniqueLanes.values()) {
    for (const dependency of lane.dependsOn) {
      if (dependency === lane.id || !uniqueLanes.has(dependency)) continue;
      indegree.set(lane.id, (indegree.get(lane.id) ?? 0) + 1);
      children.get(dependency)!.push(lane.id);
    }
  }
  for (const dependants of children.values()) dependants.sort();

  const waves: string[][] = [];
  let ready = [...uniqueLanes.keys()].filter((id) => indegree.get(id) === 0).sort();
  let visited = 0;
  while (ready.length > 0) {
    const wave = ready;
    waves.push(wave);
    visited += wave.length;
    const next: string[] = [];
    for (const id of wave) {
      for (const child of children.get(id) ?? []) {
        const remaining = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, remaining);
        if (remaining === 0) next.push(child);
      }
    }
    ready = next.sort();
  }
  const acyclic = visited === uniqueLanes.size;
  if (!acyclic && !hardBlocks.includes("dependency-cycle")) hardBlocks.push("dependency-cycle");

  const reaches = (from: string, target: string): boolean => {
    const pending = [...(children.get(from) ?? [])];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(children.get(current) ?? []));
    }
    return false;
  };
  const comparable = (left: string, right: string) => reaches(left, right) || reaches(right, left);

  const sortedLanes = [...uniqueLanes.values()].sort((left, right) => left.id.localeCompare(right.id));
  for (let i = 0; i < sortedLanes.length; i += 1) {
    for (let j = i + 1; j < sortedLanes.length; j += 1) {
      const left = sortedLanes[i]!;
      const right = sortedLanes[j]!;
      const lanesComparable = comparable(left.id, right.id);
      const leftReadsAndWrites = [...left.readScopes, ...left.writeScopes];
      const rightReadsAndWrites = [...right.readScopes, ...right.writeScopes];
      const writeCollision = left.writeScopes.some((scope) =>
        right.writeScopes.some((other) => fanoutScopesOverlap(scope, other)));
      const concurrentReadCollision = !lanesComparable && (
        left.writeScopes.some((scope) => rightReadsAndWrites.some((other) => fanoutScopesOverlap(scope, other))) ||
        right.writeScopes.some((scope) => leftReadsAndWrites.some((other) => fanoutScopesOverlap(scope, other)))
      );
      const scopeCollision = writeCollision || concurrentReadCollision;
      if (scopeCollision) hardBlocks.push(`scope-collision:${left.id}<->${right.id}`);
      const resources = new Set(left.exclusiveResources);
      if (!lanesComparable && right.exclusiveResources.some((resource) => resources.has(resource))) {
        hardBlocks.push(`exclusive-resource:${left.id}<->${right.id}`);
      }
    }
  }

  const serialWork = lanes.reduce((sum, lane) => sum + lane.estimatedWeight, 0);
  const pathWork = new Map<string, number>();
  if (acyclic) {
    for (const wave of waves) {
      for (const id of wave) {
        const lane = uniqueLanes.get(id)!;
        const dependencyWork = lane.dependsOn.reduce((max, dependency) => Math.max(max, pathWork.get(dependency) ?? 0), 0);
        pathWork.set(id, dependencyWork + lane.estimatedWeight);
      }
    }
  }
  const criticalPathWork = acyclic
    ? Math.max(...pathWork.values(), 0)
    : Math.max(...lanes.map((lane) => lane.estimatedWeight), 0);
  const maxProfile = input.executionProfile === "max";
  const writeLaneCount = lanes.filter((lane) => lane.writeScopes.length > 0).length;
  const readOnlyLaneCount = lanes.filter((lane) => lane.writeScopes.length === 0).length;
  const verificationLaneCount = lanes.filter((lane) =>
    /(test|qa|verify|verification|review|audit|regression|e2e|검증|테스트|회귀)/iu.test(lane.task),
  ).length;
  const unknownScopeCount = lanes.filter((lane) => lane.readScopes.length === 0 && lane.writeScopes.length === 0).length;
  const latencyBonus = lanes.filter((lane) => lane.latencyBound).length * (maxProfile ? 0.75 : 0.5);
  const coverageBonus = verificationLaneCount * (maxProfile ? 0.75 : 0.4);
  const readParallelBonus = readOnlyLaneCount * (maxProfile ? 0.4 : 0.2);
  const coordinationCost =
    (maxProfile ? 0.4 : 0.75) +
    Math.max(0, lanes.length - 2) * (maxProfile ? 0.2 : 0.35) +
    writeLaneCount * (maxProfile ? 0.25 : 0.35);
  const contextPollutionCost = lanes.length * 0.1 + unknownScopeCount * 0.35;
  const threshold = maxProfile ? 0.25 : 0.75;
  const netGain = Number(
    (serialWork - criticalPathWork + latencyBonus + coverageBonus + readParallelBonus - coordinationCost - contextPollutionCost).toFixed(2),
  );
  const policyBlocked = input.executionProfile === "fast";
  const uniqueHardBlocks = [...new Set(hardBlocks)];
  const recommended = !policyBlocked && uniqueHardBlocks.length === 0 && netGain >= threshold;

  return {
    state: recommended ? "fanout" : "sequential",
    recommended,
    maxLanes,
    candidateCount: lanes.length,
    serialWork,
    criticalPathWork,
    coordinationCost,
    latencyBonus,
    coverageBonus,
    readParallelBonus,
    contextPollutionCost,
    threshold,
    netGain,
    hardBlocks: uniqueHardBlocks,
    waves,
    planFingerprint: canonicalMassUlwPlanFingerprint(lanes),
    lanes,
    rationale:
      uniqueHardBlocks.length > 0
        ? `Fan-out blocked by safety guard(s): ${uniqueHardBlocks.join(", ")}.`
        : policyBlocked
          ? "Fast profile keeps candidate lanes sequential to avoid coordination overhead."
          : recommended
            ? `Performance-first fan-out gain ${netGain} clears the ${input.executionProfile} threshold (>= ${threshold}) after coordination and context-pollution costs.`
            : `Performance-first fan-out gain ${netGain} does not clear the ${input.executionProfile} threshold (>= ${threshold}); keep the work sequential.`,
  };
}

export const buildMassUlwDecision = buildMassUlwPlan;

import type { MassUlwLane, MassUlwPlan } from "./mass-ulw.js";
export function stableTopologicalWaves(lanes: readonly MassUlwLane[]): string[][] {
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  if (byId.size !== lanes.length) throw new Error("MASS ULW plan contains duplicate lane ids");
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const lane of lanes) {
    indegree.set(lane.id, 0);
    children.set(lane.id, []);
  }
  for (const lane of lanes) {
    for (const dependency of lane.dependsOn) {
      if (!byId.has(dependency) || dependency === lane.id) throw new Error(`MASS ULW plan has an invalid dependency: ${lane.id}->${dependency}`);
      indegree.set(lane.id, (indegree.get(lane.id) ?? 0) + 1);
      children.get(dependency)!.push(lane.id);
    }
  }
  for (const values of children.values()) values.sort((left, right) => left.localeCompare(right));

  const waves: string[][] = [];
  let ready = lanes.map((lane) => lane.id).filter((id) => indegree.get(id) === 0).sort((left, right) => left.localeCompare(right));
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
    ready = next.sort((left, right) => left.localeCompare(right));
  }
  if (visited !== lanes.length) throw new Error("MASS ULW plan contains a dependency cycle");
  return waves;
}

export function descendantsOf(plan: MassUlwPlan, seeds: ReadonlySet<string>): Set<string> {
  const children = new Map(plan.lanes.map((lane) => [lane.id, [] as string[]]));
  for (const lane of plan.lanes) {
    for (const dependency of lane.dependsOn) children.get(dependency)?.push(lane.id);
  }
  const descendants = new Set<string>();
  const pending = [...seeds].sort((left, right) => left.localeCompare(right));
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const child of children.get(current) ?? []) {
      if (seeds.has(child) || descendants.has(child)) continue;
      descendants.add(child);
      pending.push(child);
    }
  }
  return descendants;
}

export function topologicalLaneIds(plan: MassUlwPlan): string[] {
  return plan.waves.flatMap((wave) => wave);
}

export function ancestorsOf(plan: MassUlwPlan, laneId: string): string[] {
  const byId = new Map(plan.lanes.map((lane) => [lane.id, lane]));
  const ancestors = new Set<string>();
  const visit = (id: string): void => {
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (ancestors.has(dependency)) continue;
      ancestors.add(dependency);
      visit(dependency);
    }
  };
  visit(laneId);
  return topologicalLaneIds(plan).filter((id) => ancestors.has(id));
}

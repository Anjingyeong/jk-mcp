/**
 * Build distribution marker.
 *
 * The canonical source checkout is "internal". scripts/export-public.mjs
 * rewrites JK_DISTRIBUTION to "public" when producing the jk-mcp tree, which
 * changes only defaults — never capabilities:
 *   - Impulse Scout / Director are off unless JK_IMPULSE_SCOUT=1.
 *   - Impulse tools are not listed unless JK_TOOL_PROFILES includes +impulse.
 *
 * JK_DISTRIBUTION=public|internal overrides the baked value (tests, previews).
 */
export type JkDistribution = "internal" | "public";

export const JK_DISTRIBUTION: JkDistribution = "public";

export function jkDistribution(env: NodeJS.ProcessEnv = process.env): JkDistribution {
  const override = env.JK_DISTRIBUTION?.trim().toLowerCase();
  if (override === "public" || override === "internal") return override;
  return JK_DISTRIBUTION;
}

export function isPublicDistribution(env: NodeJS.ProcessEnv = process.env): boolean {
  return jkDistribution(env) === "public";
}

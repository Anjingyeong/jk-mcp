import type { ToolContext } from "../types.js";
import { requireProjectLease } from "../workspace/lease-guard.js";

export async function authorizeMassUlwProcessStart(ctx: ToolContext, projectId: string): Promise<void> {
  await requireProjectLease(ctx, projectId, "write");
  await requireProjectLease(ctx, projectId, "remote");
}

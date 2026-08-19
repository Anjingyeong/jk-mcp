import type { Express, Request, Response } from "express";
import { verifyOwnerToken } from "../auth/owner-token.js";
import type { ToolContext } from "../types.js";
import { verifyExecutorToken } from "./auth.js";
import {
  completeExecutorJob,
  getProjectExecutorRoutes,
  listExecutorStatus,
  pollExecutorJob,
  recordExecutorHeartbeat,
  setProjectExecutorRoute,
  type ExecutorHeartbeat,
} from "./broker.js";

function bearerToken(req: Request): string | null {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

async function requireExecutorOwner(req: Request, res: Response, ctx: ToolContext): Promise<boolean> {
  const token = bearerToken(req);
  if (!token || !(await verifyOwnerToken(ctx.stateDir, token))) {
    res.status(401).json({ error: "owner authentication required" });
    return false;
  }
  return true;
}

async function requireWorkerToken(
  req: Request,
  res: Response,
  ctx: ToolContext,
  executorId: string,
): Promise<boolean> {
  const token = bearerToken(req);
  if (!token || !(await verifyExecutorToken(ctx.stateDir, executorId, token))) {
    res.status(401).json({ error: "executor authentication required" });
    return false;
  }
  return true;
}

export function registerExecutorRoutes(app: Express, ctx: ToolContext): void {
  app.post("/api/executors/heartbeat", async (req, res) => {
    try {
      const body = req.body as Partial<ExecutorHeartbeat>;
      if (!body.executorId || !body.platform || !body.workspaceRoot || !Array.isArray(body.projects)) {
        res.status(400).json({ error: "invalid executor heartbeat" });
        return;
      }
      if (!(await requireWorkerToken(req, res, ctx, body.executorId))) return;
      const executor = await recordExecutorHeartbeat(ctx.stateDir, body as ExecutorHeartbeat);
      res.json({ ok: true, executor });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/executors/:executorId/poll", async (req, res) => {
    if (!(await requireWorkerToken(req, res, ctx, req.params.executorId))) return;
    try {
      const waitMs = typeof req.body?.waitMs === "number" ? req.body.waitMs : undefined;
      const job = await pollExecutorJob(req.params.executorId, waitMs);
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/executors/:executorId/jobs/:jobId/result", async (req, res) => {
    if (!(await requireWorkerToken(req, res, ctx, req.params.executorId))) return;
    const accepted = completeExecutorJob(
      req.params.jobId,
      req.body?.result,
      typeof req.body?.error === "string" ? req.body.error : undefined,
      req.params.executorId,
    );
    if (!accepted) {
      res.status(404).json({ error: "executor job not found or already completed" });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/api/executors", async (req, res) => {
    if (!(await requireExecutorOwner(req, res, ctx))) return;
    res.json({ executors: await listExecutorStatus(ctx.stateDir), routes: await getProjectExecutorRoutes(ctx.stateDir) });
  });

  app.post("/api/executors/routes", async (req, res) => {
    if (!(await requireExecutorOwner(req, res, ctx))) return;
    const projectId = typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";
    const executorId = typeof req.body?.executorId === "string" ? req.body.executorId.trim() : "";
    if (!projectId || !executorId) {
      res.status(400).json({ error: "projectId and executorId are required" });
      return;
    }
    try {
      await setProjectExecutorRoute(ctx.stateDir, projectId, executorId === "local" ? null : executorId);
      res.json({ ok: true, projectId, executorId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { verifyOwnerToken } from "../auth/owner-token.js";
import type { ToolContext } from "../types.js";
import { verifyExecutorToken } from "./auth.js";
import {
  acknowledgeExecutorJobCancellation,
  acknowledgeExecutorControl,
  completeExecutorJob,
  completeDurableExecutorJob,
  getProjectExecutorRoutes,
  listExecutorStatus,
  pollExecutorJob,
  recordExecutorHeartbeat,
  setProjectExecutorRoute,
  takeExecutorControl,
  type ExecutorHeartbeat,
} from "./broker.js";
import { createRuntimeIdentity, RuntimeIdentitySchema, DURABLE_RESULT_CAPABILITY, DurableResultSubmissionSchema, type RuntimeIdentity } from "./target-protocol.js";
import { JobDeliveryError, resultDeliveryDigest } from "./job-delivery-store.js";

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

const EXECUTOR_BINARY_RESULT_LIMIT = "11mb";
const EXECUTOR_BINARY_META_MAX_CHARS = 48_000;

function decodeBinaryResultMeta(req: Request): { result: Record<string, unknown>; error?: string; identity: RuntimeIdentity; field: "imageBase64" | "data"; mime: string } {
  const encoded = req.header("x-jk-result-meta") ?? "";
  const field = req.header("x-jk-binary-field");
  const mime = req.header("x-jk-binary-mime") ?? "";
  if (!encoded || encoded.length > EXECUTOR_BINARY_META_MAX_CHARS) throw new Error("invalid executor binary result metadata");
  if (field !== "imageBase64" && field !== "data") throw new Error("invalid executor binary result field");
  if (!/^image\/(?:png|jpeg|gif|webp)$/i.test(mime)) throw new Error("invalid executor binary result mime");
  const meta = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { result?: unknown; error?: unknown; identity?: unknown };
  if (!meta.result || typeof meta.result !== "object" || Array.isArray(meta.result)) throw new Error("invalid executor binary result object");
  return {
    result: meta.result as Record<string, unknown>,
    error: typeof meta.error === "string" ? meta.error : undefined,
    identity: RuntimeIdentitySchema.parse(meta.identity),
    field,
    mime,
  };
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
      const identity = RuntimeIdentitySchema.parse(executor);
      const control = await takeExecutorControl(ctx.stateDir, body.executorId, identity);
      if (control?.restart) {
        const requestId = control.restart.requestId;
        res.once("finish", () => { acknowledgeExecutorControl(ctx.stateDir, body.executorId!, identity, requestId); });
      }
      if (control?.cancelJob) {
        const jobId = control.cancelJob.jobId;
        res.once("finish", () => { acknowledgeExecutorJobCancellation(ctx.stateDir, body.executorId!, identity, jobId); });
      }
      res.json({ ok: true, executor, hub: await createRuntimeIdentity("hub", ctx.workspaceRoot, "local", [DURABLE_RESULT_CAPABILITY]), ...(control ? { control } : {}) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/executors/:executorId/poll", async (req, res) => {
    if (!(await requireWorkerToken(req, res, ctx, req.params.executorId))) return;
    try {
      const waitMs = typeof req.body?.waitMs === "number" ? req.body.waitMs : undefined;
      const identity = RuntimeIdentitySchema.parse(req.body?.identity);
      const job = await pollExecutorJob(req.params.executorId, waitMs, identity, ctx.stateDir);
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post(
    "/api/executors/:executorId/jobs/:jobId/result-binary",
    async (req: Request, res: Response, next: NextFunction) => {
      const executorId = typeof req.params.executorId === "string" ? req.params.executorId : "";
      if (!executorId || !(await requireWorkerToken(req, res, ctx, executorId))) return;
      next();
    },
    express.raw({ type: "application/octet-stream", limit: EXECUTOR_BINARY_RESULT_LIMIT }),
    async (req, res) => {
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new Error("executor binary result body is empty");
        const meta = decodeBinaryResultMeta(req);
        const base64 = req.body.toString("base64");
        const result = { ...meta.result };
        if (meta.field === "imageBase64") result.imageBase64 = base64;
        else result.data = `data:${meta.mime};base64,${base64}`;
        const executorId = typeof req.params.executorId === "string" ? req.params.executorId : "";
        const jobId = typeof req.params.jobId === "string" ? req.params.jobId : "";
        if (!executorId || !jobId) throw new Error("invalid executor binary result route");
        const accepted = completeExecutorJob(jobId, result, meta.error, executorId, meta.identity);
        if (!accepted) {
          res.status(404).json({ error: "executor job not found or already completed" });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post("/api/executors/:executorId/jobs/:jobId/result", async (req, res) => {
    if (!(await requireWorkerToken(req, res, ctx, req.params.executorId))) return;
    if (req.body && ("delivery" in req.body || "courierRuntime" in req.body)) {
      const parsed = DurableResultSubmissionSchema.safeParse(req.body);
      if (!parsed.success || resultDeliveryDigest(parsed.data.delivery) !== parsed.data.delivery.resultDigest) {
        res.status(400).json({ error: "invalid durable result protocol" }); return;
      }
      try {
        const ack = await completeDurableExecutorJob(ctx.stateDir, req.params.executorId, req.params.jobId, parsed.data);
        res.json(ack);
      } catch (error) {
        const reason = error instanceof JobDeliveryError ? error.reason : undefined;
        const status = reason === "CONFLICT" ? 409 : reason === "NOT_FOUND" || reason === "UNAUTHORIZED" || reason === "NOT_OFFERED" ? 404
          : reason === "RESULT_TOO_LARGE" ? 413 : reason === "UNREADABLE" || reason === "LOCKED" || reason === "INVALID_RECORD" ? 503 : 400;
        res.status(status).json({ error: "durable executor result rejected" });
      }
      return;
    }
    const accepted = completeExecutorJob(
      req.params.jobId,
      req.body?.result,
      typeof req.body?.error === "string" ? req.body.error : undefined,
      req.params.executorId,
      req.body?.identity,
    );
    if (!accepted) {
      res.status(404).json({ error: "executor job not found or already completed" });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/api/executors", async (req, res) => {
    if (!(await requireExecutorOwner(req, res, ctx))) return;
    res.json({ hub: await createRuntimeIdentity("hub", ctx.workspaceRoot, "local", [DURABLE_RESULT_CAPABILITY]),
      executors: await listExecutorStatus(ctx.stateDir), routes: await getProjectExecutorRoutes(ctx.stateDir) });
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

import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { json } from "express";
import type { Express, Response } from "express";
import { z } from "zod";
import { buildActiveRoleContext, resolveCanonicalRoleProjectId } from "../roles/roles.js";
import { DomainError, ErrorCode, type LeasePreset, type ToolContext } from "../types.js";
import { consumeLocalShellApproval, listPendingLocalShellApprovals, resolveLocalShellApproval } from "../policy/local-approvals.js";
import {
  listRecentLocalShellJobs,
  markLocalShellJobDenied,
  publicLocalShellJob,
  readLocalShellJob,
  reconcileLocalShellJobs,
  updateLocalShellJob,
  type LocalShellJobRecord,
} from "../policy/local-shell-jobs.js";
import { runLocalShell } from "../exec/local-shell.js";
import { redact } from "../policy/secrets.js";
import {
  dispatchExecutorJob,
  getExecutorProjectRegistry,
  getProjectExecutorRoutes,
  listExecutorStatus,
  setProjectExecutorRoute,
} from "../executors/broker.js";
import { issueExecutorToken, revokeExecutorToken } from "../executors/auth.js";
import { readNtfySettings, saveNtfySettings, sendJkPush } from "../notifications/ntfy.js";
import { WINDOWS_EXECUTOR_BOOTSTRAP_JS } from "../executors/windows-bootstrap.js";
import { WINDOWS_EXECUTOR_SUPERVISOR_JS } from "../executors/windows-supervisor.js";
import { requireProjectLease } from "../workspace/lease-guard.js";
import { makeLease } from "../workspace/project-select.js";
import { readTaskExecutionView, type TaskExecutionSnapshot } from "./execution.js";
import { CONTROL_CENTER_HTML } from "./ui.js";
import {
  CONTROL_CENTER_LOGIN_HTML,
  canServeRemoteLogin,
  loginRemoteOwner,
  logoutRemoteOwner,
  requireControlApiAccess,
  requireControlPageAccess,
} from "./auth.js";

const ActivateProjectSchema = z.object({
  preset: z.enum(["read-only", "tests-only", "full-write", "image-only"]).default("full-write"),
});
const ResolveApprovalSchema = z.object({ decision: z.enum(["approve", "supervise", "deny"]) });

const MAX_AUDIT_READ_BYTES = 512 * 1024;
const AUDIT_FILE = "audit.jsonl";

function sendApiError(res: Response, err: unknown): void {
  if (err instanceof z.ZodError) {
    res.status(400).json({ ok: false, error: "Invalid control-center input", details: err.flatten() });
    return;
  }
  if (err instanceof DomainError) {
    const status = err.code === ErrorCode.PROJECT_NOT_FOUND ? 404 : err.code === ErrorCode.PERMISSION_DENIED ? 403 : 400;
    res.status(status).json({ ok: false, code: err.code, error: err.message, details: err.details });
    return;
  }
  res.status(500).json({ ok: false, error: (err as Error).message || "Control Center request failed" });
}

function modeForPreset(preset: LeasePreset): "observe" | "read" | "edit" | "verify" | "danger" {
  if (preset === "read-only") return "read";
  if (preset === "tests-only") return "verify";
  return "edit";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

type TaskContinuationStatus = "waiting-approval" | "running" | "ready-to-resume" | "blocked" | "denied";

async function updateJobTaskContinuation(
  ctx: ToolContext,
  job: LocalShellJobRecord,
  status: TaskContinuationStatus,
): Promise<void> {
  const link = job.continuation;
  if (!link || (!link.goalId && !link.loopId)) return;
  const now = Date.now();
  const mutate = (raw: unknown): unknown => {
    const session = asRecord(raw);
    const applyToContext = (rawContext: unknown): Record<string, unknown> | null => {
      const context = asRecord(rawContext);
      if (Object.keys(context).length === 0) return null;
      const task = asRecord(context.taskState);
      if (link.goalId && task.goalId !== link.goalId) return null;
      if (link.loopId && task.loopId !== link.loopId) return null;
      return {
        ...context,
        taskState: {
          ...task,
          continuation: { jobId: job.id, status, updatedAt: now },
          updatedAt: now,
        },
        lastActivityAt: now,
      };
    };

    if (link.workSessionId) {
      const workSessions = asRecord(session.workSessions);
      const projectSessions = asRecord(workSessions[job.projectId]);
      const nextContext = applyToContext(projectSessions[link.workSessionId]);
      if (!nextContext) return raw;
      return {
        ...session,
        updatedAt: now,
        workSessions: {
          ...workSessions,
          [job.projectId]: { ...projectSessions, [link.workSessionId]: nextContext },
        },
      };
    }

    const workContexts = asRecord(session.workContexts);
    const nextContext = applyToContext(workContexts[job.projectId]);
    if (!nextContext) return raw;
    return {
      ...session,
      updatedAt: now,
      workContexts: { ...workContexts, [job.projectId]: nextContext },
    };
  };

  if (ctx.store.updateSession) {
    await ctx.store.updateSession(mutate);
    return;
  }
  await ctx.store.setSession(mutate(await ctx.store.getSession()));
}

function projectName(ctx: ToolContext, projectId: string): string {
  return ctx.registry.find((project) => project.projectId === projectId)?.name ?? projectId;
}

function summarizeTaskState(
  ctx: ToolContext,
  projectId: string,
  workSessionId: string | null,
  context: Record<string, unknown>,
  activeProjectId: string | null,
): Record<string, unknown> | null {
  const task = asRecord(context.taskState);
  const currentGoal = typeof task.currentGoal === "string" ? task.currentGoal : null;
  const currentTask = typeof task.currentTask === "string" ? task.currentTask : null;
  const goalId = typeof task.goalId === "string" ? task.goalId : null;
  const loopId = typeof task.loopId === "string" ? task.loopId : null;
  if (!currentGoal && !currentTask && !goalId && !loopId) return null;
  return {
    projectId,
    projectName: projectName(ctx, projectId),
    workSessionId,
    goalId,
    loopId,
    currentGoal,
    currentTask,
    lastProgressSummary: typeof task.lastProgressSummary === "string" ? task.lastProgressSummary : null,
    completed: Array.isArray(task.completed) ? task.completed.filter((item): item is string => typeof item === "string").slice(-50) : [],
    pending: Array.isArray(task.pending) ? task.pending.filter((item): item is string => typeof item === "string").slice(-50) : [],
    decisions: Array.isArray(task.decisions) ? task.decisions.slice(-10) : [],
    continuation: Object.keys(asRecord(task.continuation)).length ? task.continuation : null,
    updatedAt: typeof task.updatedAt === "number" ? task.updatedAt : typeof context.lastActivityAt === "number" ? context.lastActivityAt : 0,
    lastMutation: context.lastMutation ?? null,
    lastVerification: context.lastVerification ?? null,
    active: projectId === activeProjectId && Boolean(loopId || goalId),
  };
}

function collectGoals(ctx: ToolContext, session: Record<string, unknown>): Record<string, unknown>[] {
  const activeProjectId = typeof session.activeProjectId === "string" ? session.activeProjectId : null;
  const byKey = new Map<string, Record<string, unknown>>();
  const contexts = asRecord(session.workContexts);
  for (const [projectId, rawContext] of Object.entries(contexts)) {
    const summary = summarizeTaskState(ctx, projectId, null, asRecord(rawContext), activeProjectId);
    if (summary) byKey.set(`${projectId}:default`, summary);
  }
  const sessions = asRecord(session.workSessions);
  for (const [projectId, rawSessions] of Object.entries(sessions)) {
    for (const [workSessionId, rawContext] of Object.entries(asRecord(rawSessions))) {
      const summary = summarizeTaskState(ctx, projectId, workSessionId, asRecord(rawContext), activeProjectId);
      if (summary) byKey.set(`${projectId}:${workSessionId}`, summary);
    }
  }
  return [...byKey.values()].sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
}

function taskExecutionSnapshot(goal: Record<string, unknown> | null): TaskExecutionSnapshot | null {
  if (!goal) return null;
  const completed = Array.isArray(goal.completed) ? goal.completed.filter((item): item is string => typeof item === "string") : [];
  const pending = Array.isArray(goal.pending) ? goal.pending.filter((item): item is string => typeof item === "string") : [];
  const lastMutation = asRecord(goal.lastMutation);
  const lastVerification = asRecord(goal.lastVerification);
  return {
    projectId: typeof goal.projectId === "string" ? goal.projectId : null,
    projectName: typeof goal.projectName === "string" ? goal.projectName : null,
    goalId: typeof goal.goalId === "string" ? goal.goalId : null,
    loopId: typeof goal.loopId === "string" ? goal.loopId : null,
    currentGoal: typeof goal.currentGoal === "string" ? goal.currentGoal : null,
    currentTask: typeof goal.currentTask === "string" ? goal.currentTask : null,
    lastProgressSummary: typeof goal.lastProgressSummary === "string" ? goal.lastProgressSummary : null,
    completed,
    pending,
    updatedAt: typeof goal.updatedAt === "number" ? goal.updatedAt : 0,
    lastMutation: Object.keys(lastMutation).length ? { at: typeof lastMutation.at === "number" ? lastMutation.at : undefined } : null,
    lastVerification: Object.keys(lastVerification).length
      ? {
          success: typeof lastVerification.success === "boolean" ? lastVerification.success : undefined,
          at: typeof lastVerification.at === "number" ? lastVerification.at : undefined,
          tool: typeof lastVerification.tool === "string" ? lastVerification.tool : undefined,
        }
      : null,
  };
}

async function readRecentAuditEvents(stateDir: string, limit: number): Promise<Record<string, unknown>[]> {
  const target = path.join(stateDir, AUDIT_FILE);
  try {
    const info = await stat(target);
    const bytes = Math.min(info.size, MAX_AUDIT_READ_BYTES);
    if (bytes <= 0) return [];
    const handle = await open(target, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      await handle.read(buffer, 0, bytes, Math.max(0, info.size - bytes));
      const text = buffer.toString("utf8");
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (info.size > bytes && lines.length > 0) lines.shift();
      const events: Record<string, unknown>[] = [];
      for (const line of lines.slice(-limit).reverse()) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const type = typeof event.type === "string" ? event.type : "event";
          const detailCandidates = [event.toolName, event.tool, event.roleName, event.commandId, event.capability, event.status, event.path];
          const detail = detailCandidates.filter((value) => typeof value === "string" && value.length > 0).slice(0, 3).join(" · ");
          events.push({
            type,
            ts: typeof event.ts === "number" ? event.ts : 0,
            projectId: typeof event.projectId === "string" ? event.projectId : null,
            detail,
          });
        } catch {
          // Ignore a malformed historical line rather than breaking the local dashboard.
        }
      }
      return events;
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function updateSession(ctx: ToolContext, mutator: (current: Record<string, unknown>) => Record<string, unknown>): Promise<unknown> {
  if (ctx.store.updateSession) {
    return ctx.store.updateSession((current) => mutator(asRecord(current)));
  }
  const current = asRecord(await ctx.store.getSession());
  const next = mutator(current);
  await ctx.store.setSession(next);
  return next;
}

function setLocalPageHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' blob: data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
}

function escapeReviewHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function loadReviewBundle(ctx: ToolContext, projectId: string): Promise<{
  projectName: string;
  date: string;
  publishDir: string;
  cards: string[];
  caption: string;
  designScore: number | null;
  designFailures: string[];
  designSystem: string | null;
  downloadBundle: string | null;
  publisherConfigured: boolean;
  sourceCount: number;
}> {
  const registry = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
  const project = registry.find((entry) => entry.projectId === projectId);
  if (!project) throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Unknown project: ${projectId}`);

  const latestPath = path.join(project.root, "var", "output", "latest-ready.json");
  let latest: Record<string, unknown>;
  try {
    latest = asRecord(JSON.parse(await readFile(latestPath, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `No ready review package for ${projectId}`);
    }
    throw err;
  }
  const date = typeof latest.date === "string" ? latest.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "latest-ready.json has an invalid date");
  }

  const publishDir = path.join(project.root, "var", "output", date, "publish");
  const manifest = asRecord(JSON.parse(await readFile(path.join(publishDir, "manifest.json"), "utf8")));
  const cards = Array.isArray(manifest.cards)
    ? manifest.cards.filter((card): card is string => typeof card === "string" && /^\d{2}\.png$/.test(card))
    : [];
  if (cards.length === 0) throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, "Ready package has no reviewable cards");
  const caption = await readFile(path.join(publishDir, "caption.txt"), "utf8");
  const designScore = typeof manifest.design_qa_score === "number" ? manifest.design_qa_score : null;
  const designFailures = Array.isArray(manifest.design_qa_failures)
    ? manifest.design_qa_failures.filter((item): item is string => typeof item === "string")
    : [];
  const designSystem = typeof manifest.design_system === "string" ? manifest.design_system : null;
  const downloadBundle =
    typeof manifest.download_bundle === "string" && /^[A-Za-z0-9._-]+\.zip$/.test(manifest.download_bundle)
      ? manifest.download_bundle
      : null;
  const publisherConfigured = asRecord(manifest.publisher).configured === true;
  const sourceCount = typeof manifest.source_count === "number" ? manifest.source_count : 0;
  return { projectName: project.name, date, publishDir, cards, caption, designScore, designFailures, designSystem, downloadBundle, publisherConfigured, sourceCount };
}

function reviewInboxHtml(projectId: string, bundle: Awaited<ReturnType<typeof loadReviewBundle>>): string {
  const safeProjectId = encodeURIComponent(projectId);
  const cards = bundle.cards.map((card, index) => `<figure class="card"><img src="/review/${safeProjectId}/card/${encodeURIComponent(card)}" alt="카드뉴스 ${index + 1}/${bundle.cards.length}" loading="${index === 0 ? "eager" : "lazy"}"><figcaption>${index + 1}/${bundle.cards.length}</figcaption></figure>`).join("");
  const score = bundle.designScore === null ? "-" : String(bundle.designScore);
  const status = bundle.designFailures.length === 0 ? "READY" : "HOLD";
  const downloadButton = bundle.downloadBundle ? `<a class="btn primary" href="/review/${safeProjectId}/download">5장 ZIP 받기</a>` : "";
  const designSystem = bundle.designSystem ?? "-";
  const publisherStatus = bundle.publisherConfigured ? "CONNECTED" : "NOT CONNECTED";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${escapeReviewHtml(bundle.projectName)} · Review Inbox</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b0d10;color:#f5f7fa;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:#c8ff53;text-decoration:none}.wrap{width:min(980px,100%);margin:auto;padding:20px 16px 56px}.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:18px}.eyebrow{font-size:12px;letter-spacing:.12em;color:#8b95a5;text-transform:uppercase}.top h1{font-size:25px;margin:5px 0 4px}.sub{color:#9aa3b2;font-size:14px}.badge{padding:8px 12px;border-radius:999px;background:#c8ff53;color:#101410;font-weight:850;font-size:12px}.rail{display:flex;gap:14px;overflow-x:auto;scroll-snap-type:x mandatory;padding:2px 1px 14px}.card{min-width:min(84vw,430px);margin:0;scroll-snap-align:center}.card img{display:block;width:100%;aspect-ratio:4/5;object-fit:contain;background:#14181e;border:1px solid #252b34;border-radius:18px}.card figcaption{text-align:center;color:#737e8d;font-size:12px;margin-top:7px}.grid{display:grid;grid-template-columns:1.25fr .75fr;gap:14px;margin-top:10px}.panel{background:#11151a;border:1px solid #252b34;border-radius:16px;padding:16px}.panel h2{font-size:15px;margin:0 0 11px}.caption{white-space:pre-wrap;line-height:1.65;color:#dde2e8;font-size:14px;max-height:360px;overflow:auto}.metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px}.metric{padding:12px;border-radius:12px;background:#0b0f13}.metric b{display:block;font-size:19px}.metric span{font-size:11px;color:#7e8998}.actions{display:flex;gap:8px;margin-top:12px}.btn{display:inline-block;border:1px solid #313844;background:#171c22;color:#fff;border-radius:10px;padding:10px 12px;font-weight:700;cursor:pointer}.btn.primary{background:#c8ff53;color:#111;border-color:#c8ff53}@media(max-width:720px){.grid{grid-template-columns:1fr}.wrap{padding-left:12px;padding-right:12px}.top h1{font-size:22px}.card{min-width:88vw}}
  </style></head><body><main class="wrap"><header class="top"><div><div class="eyebrow">JK · Review Inbox</div><h1>${escapeReviewHtml(bundle.projectName)}</h1><div class="sub">${escapeReviewHtml(bundle.date)} · 최신 게시 가능 패키지</div></div><div class="badge">${status}</div></header><section class="rail" aria-label="카드 미리보기">${cards}</section><section class="grid"><div class="panel"><h2>Instagram caption</h2><div class="caption" id="caption">${escapeReviewHtml(bundle.caption)}</div><div class="actions">${downloadButton}<button class="btn" id="copy-caption">캡션 복사</button><button class="btn" id="instagram-publish" disabled data-publisher-configured="${bundle.publisherConfigured ? "true" : "false"}">Instagram 게시</button><a class="btn" href="/">JK로 돌아가기</a></div><div class="sub" style="margin-top:10px">Instagram 게시 버튼은 Professional 계정/API 연결 뒤에만 활성화됩니다.</div></div><aside class="panel"><h2>QA &amp; Publish</h2><div class="metrics"><div class="metric"><b>${score}</b><span>Design QA</span></div><div class="metric"><b>${bundle.cards.length}</b><span>Cards</span></div><div class="metric"><b>${bundle.sourceCount}</b><span>Official sources</span></div><div class="metric"><b>${status}</b><span>Publish state</span></div><div class="metric"><b>${escapeReviewHtml(designSystem)}</b><span>Design system</span></div><div class="metric"><b>${publisherStatus}</b><span>Instagram</span></div></div></aside></section></main><script>document.getElementById('copy-caption').onclick=async()=>{const b=document.getElementById('copy-caption');try{await navigator.clipboard.writeText(document.getElementById('caption').innerText);b.textContent='복사 완료';setTimeout(()=>b.textContent='캡션 복사',1400)}catch{b.textContent='복사 실패'}}</script></body></html>`;
}

async function startApprovedLocalShellJob(ctx: ToolContext, approvalId: string): Promise<ReturnType<typeof publicLocalShellJob> | null> {
  const job = await readLocalShellJob(ctx.stateDir, approvalId);
  if (!job || job.status !== "pending") return job ? publicLocalShellJob(job) : null;

  try {
    await requireProjectLease(ctx, job.projectId, job.writesWorkspace ? "write" : "verify");
  } catch (err) {
    await consumeLocalShellApproval(ctx.stateDir, {
      projectId: job.projectId,
      command: job.command,
      cwd: job.cwd ?? undefined,
      reason: job.reason ?? undefined,
      needsNetwork: job.needsNetwork,
      destructive: job.destructive,
    });
    const failed = await updateLocalShellJob(ctx.stateDir, approvalId, (current) => ({
      ...current,
      status: "failed",
      finishedAt: Date.now(),
      error: redact((err as Error).message || "Project lease no longer authorizes this job"),
    }));
    if (failed) await updateJobTaskContinuation(ctx, failed, "blocked");
    return failed ? publicLocalShellJob(failed) : null;
  }

  const approved = await consumeLocalShellApproval(ctx.stateDir, {
    projectId: job.projectId,
    command: job.command,
    cwd: job.cwd ?? undefined,
    reason: job.reason ?? undefined,
    needsNetwork: job.needsNetwork,
    destructive: job.destructive,
  });
  if (!approved) {
    throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "Approved local shell job could not consume its exact approval token", {
      approvalId,
    });
  }

  const remoteProjects = await getExecutorProjectRegistry(ctx.stateDir, ctx.registry);
  const project = [...ctx.registry, ...remoteProjects].find((entry) => entry.projectId === job.projectId);
  if (!project) {
    const failed = await updateLocalShellJob(ctx.stateDir, approvalId, (current) => ({
      ...current,
      status: "failed",
      finishedAt: Date.now(),
      error: "Project is no longer registered",
    }));
    if (failed) await updateJobTaskContinuation(ctx, failed, "blocked");
    return failed ? publicLocalShellJob(failed) : null;
  }

  const running = await updateLocalShellJob(ctx.stateDir, approvalId, (current) => ({
    ...current,
    status: "running",
    startedAt: Date.now(),
  }));
  if (!running) return null;
  await updateJobTaskContinuation(ctx, running, "running");

  await ctx.ledger.append({
    type: "local.job.started",
    projectId: job.projectId,
    approvalId,
    command: redact(job.command),
  });

  void (async () => {
    try {
      const executorId =
        project.executorKind === "remote" && typeof project.executorId === "string" && project.executorId.length > 0
          ? project.executorId
          : null;
      const result = executorId
        ? await dispatchExecutorJob<Awaited<ReturnType<typeof runLocalShell>>>(
            ctx.stateDir,
            executorId,
            "local_shell_run",
            {
              sourceProjectId: project.sourceProjectId ?? project.projectId,
              command: job.command,
              cwd: job.cwd ?? undefined,
              timeoutSec: job.timeoutSec ?? undefined,
              approvedNeedsNetwork: job.needsNetwork,
              approvedDestructive: job.destructive,
            },
            Math.max(60_000, (job.timeoutSec ?? 30) * 1_000 + 10_000),
          )
        : await runLocalShell(project.root, job.command, job.cwd ?? undefined, job.timeoutSec ?? undefined, {
            needsNetwork: job.needsNetwork,
            destructive: job.destructive,
          });
      const finished = await updateLocalShellJob(ctx.stateDir, approvalId, (current) => ({
        ...current,
        status: result.exitCode === 0 ? "succeeded" : "failed",
        finishedAt: Date.now(),
        exitCode: result.exitCode,
        stdoutSummary: redact(result.stdoutSummary),
        stderrSummary: redact(result.stderrSummary),
        durationMs: result.durationMs,
      }));
      if (finished) {
        await updateJobTaskContinuation(ctx, finished, result.exitCode === 0 ? "ready-to-resume" : "blocked");
      }
      await ctx.ledger.append({
        type: "local.job.finished",
        projectId: job.projectId,
        approvalId,
        exitCode: result.exitCode,
      });
    } catch (err) {
      const failed = await updateLocalShellJob(ctx.stateDir, approvalId, (current) => ({
        ...current,
        status: "failed",
        finishedAt: Date.now(),
        error: redact((err as Error).message || "Local shell job failed"),
      }));
      if (failed) await updateJobTaskContinuation(ctx, failed, "blocked");
      await ctx.ledger.append({
        type: "local.job.failed",
        projectId: job.projectId,
        approvalId,
      });
    }
  })();

  return publicLocalShellJob(running);
}

/** Local-only web management surface served by the same HTTP runtime as /mcp. */
export function registerControlCenterRoutes(app: Express, ctx: ToolContext): void {
  void reconcileLocalShellJobs(ctx.stateDir).catch(() => undefined);
  const pageAccess = requireControlPageAccess(ctx);
  const apiAccess = requireControlApiAccess(ctx);

  app.get("/login", (req, res) => {
    if (!canServeRemoteLogin(req)) {
      res.status(403).json({ ok: false, error: "JK remote management is not enabled for this host." });
      return;
    }
    setLocalPageHeaders(res);
    res.type("html").send(CONTROL_CENTER_LOGIN_HTML);
  });

  app.post("/api/jk/control/login", json({ limit: "8kb" }), async (req, res) => {
    try {
      await loginRemoteOwner(ctx, req, res);
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.post("/api/jk/control/logout", apiAccess, (_req, res) => {
    logoutRemoteOwner(ctx, _req, res);
  });

  app.get("/", pageAccess, (_req, res) => {
    setLocalPageHeaders(res);
    res.type("html").send(CONTROL_CENTER_HTML);
  });

  app.get("/approvals", pageAccess, (_req, res) => {
    setLocalPageHeaders(res);
    res.type("html").send(CONTROL_CENTER_HTML);
  });

  app.get("/review/:projectId", pageAccess, async (req, res) => {
    setLocalPageHeaders(res);
    try {
      const projectId = routeParam(req.params.projectId);
      const bundle = await loadReviewBundle(ctx, projectId);
      res.type("html").send(reviewInboxHtml(projectId, bundle));
    } catch (err) {
      const status = err instanceof DomainError && err.code === ErrorCode.PROJECT_NOT_FOUND ? 404 : 400;
      res.status(status).type("text/plain").send(redact((err as Error).message || "Review package unavailable"));
    }
  });

  app.get("/review/:projectId/download", pageAccess, async (req, res) => {
    setLocalPageHeaders(res);
    try {
      const projectId = routeParam(req.params.projectId);
      const bundle = await loadReviewBundle(ctx, projectId);
      if (!bundle.downloadBundle) {
        res.status(404).type("text/plain").send("Download bundle not found");
        return;
      }
      const safeProjectId = projectId.replace(/[^A-Za-z0-9._-]/g, "_");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${safeProjectId}-${bundle.date}.zip"`);
      res.send(await readFile(path.join(bundle.publishDir, bundle.downloadBundle)));
    } catch (err) {
      const status = err instanceof DomainError && err.code === ErrorCode.PROJECT_NOT_FOUND ? 404 : 400;
      res.status(status).type("text/plain").send(redact((err as Error).message || "Review bundle unavailable"));
    }
  });

  app.get("/review/:projectId/card/:filename", pageAccess, async (req, res) => {
    setLocalPageHeaders(res);
    try {
      const projectId = routeParam(req.params.projectId);
      const bundle = await loadReviewBundle(ctx, projectId);
      const filename = routeParam(req.params.filename);
      if (!bundle.cards.includes(filename)) {
        res.status(404).type("text/plain").send("Card not found");
        return;
      }
      res.type("png").send(await readFile(path.join(bundle.publishDir, filename)));
    } catch (err) {
      const status = err instanceof DomainError && err.code === ErrorCode.PROJECT_NOT_FOUND ? 404 : 400;
      res.status(status).type("text/plain").send(redact((err as Error).message || "Review card unavailable"));
    }
  });

  app.use("/api/jk/control", apiAccess, json({ limit: "128kb" }));

  app.get("/api/jk/control/status", async (_req, res) => {
    try {
      const session = asRecord(await ctx.store.getSession());
      const activeProjectId = typeof session.activeProjectId === "string" ? session.activeProjectId : null;
      const roleContext = activeProjectId ? await buildActiveRoleContext(ctx, activeProjectId) : null;
      const lease = asRecord(session.lease);
      let deployment: Record<string, unknown> | null = null;
      try {
        deployment = asRecord(JSON.parse(await readFile(path.join(ctx.stateDir, "deploy-status.json"), "utf8")));
      } catch {
        deployment = null;
      }
      let quickLinks: Array<Record<string, string>> = [];
      try {
        const parsed = JSON.parse(await readFile(path.join(ctx.stateDir, "control-center", "quick-links.json"), "utf8"));
        if (Array.isArray(parsed)) {
          quickLinks = parsed.slice(0, 24).flatMap((item) => {
            const record = asRecord(item);
            const title = typeof record.title === "string" ? record.title.trim().slice(0, 80) : "";
            const href = typeof record.href === "string" ? record.href.trim().slice(0, 1000) : "";
            if (!title || !/^https?:\/\//i.test(href)) return [];
            return [{
              title,
              href,
              note: typeof record.note === "string" ? record.note.trim().slice(0, 160) : "",
              badge: typeof record.badge === "string" ? record.badge.trim().slice(0, 40) : "Link",
              badgeClass: typeof record.badgeClass === "string" && /^(ok|warn|active|default)$/.test(record.badgeClass) ? record.badgeClass : "default",
            }];
          });
        }
      } catch {
        quickLinks = [];
      }
      const [executorItems, executorRoutes] = await Promise.all([
        listExecutorStatus(ctx.stateDir),
        getProjectExecutorRoutes(ctx.stateDir),
      ]);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        runtime: {
          name: "JK",
          pid: process.pid,
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          mode: process.env.JK_RUNTIME_MODE ?? "unknown",
          runtimeRoot: process.env.JK_RUNTIME_ROOT ?? null,
          uptimeSec: process.uptime(),
          workspaceRoot: ctx.workspaceRoot,
          stateDir: ctx.stateDir,
        },
        executors: {
          local: {
            executorId: "local",
            label: "Local Hub",
            online: true,
            platform: `${process.platform}/${process.arch}`,
            workspaceRoot: ctx.workspaceRoot,
            projectCount: ctx.registry.length,
          },
          items: executorItems,
          routes: executorRoutes,
        },
        session: {
          activeProjectId,
          mode: typeof session.mode === "string" ? session.mode : null,
          leasePreset: typeof lease.preset === "string" ? lease.preset : null,
          leaseExpiresAt: typeof lease.expiresAt === "number" ? lease.expiresAt : null,
        },
        quickLinks,
        deployment,
        roleContext,
      });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.get("/api/jk/control/executors/windows-bootstrap.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("application/javascript; charset=utf-8").send(WINDOWS_EXECUTOR_BOOTSTRAP_JS);
  });

  app.get("/api/jk/control/executors/windows-supervisor.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("application/javascript; charset=utf-8").send(WINDOWS_EXECUTOR_SUPERVISOR_JS);
  });

  app.post("/api/jk/control/executors/routes", async (req, res) => {
    try {
      const projectId = typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";
      const executorId = typeof req.body?.executorId === "string" ? req.body.executorId.trim() : "";
      if (!projectId || !executorId) throw new Error("projectId and executorId are required");
      await setProjectExecutorRoute(ctx.stateDir, projectId, executorId === "local" ? null : executorId);
      res.json({ ok: true, projectId, executorId });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.post("/api/jk/control/executors/:executorId/token", async (req, res) => {
    try {
      const executorId = req.params.executorId.trim();
      const token = await issueExecutorToken(ctx.stateDir, executorId);
      await ctx.ledger.append({ type: "executor.token.issued", executorId });
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, executorId, token });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.delete("/api/jk/control/executors/:executorId/token", async (req, res) => {
    try {
      const executorId = req.params.executorId.trim();
      const revoked = await revokeExecutorToken(ctx.stateDir, executorId);
      if (revoked) await ctx.ledger.append({ type: "executor.token.revoked", executorId });
      res.json({ ok: true, executorId, revoked });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.get("/api/jk/control/goals", async (_req, res) => {
    try {
      const session = asRecord(await ctx.store.getSession());
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, goals: collectGoals(ctx, session) });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.get("/api/jk/control/execution", async (_req, res) => {
    try {
      const session = asRecord(await ctx.store.getSession());
      const activeProjectId = typeof session.activeProjectId === "string" ? session.activeProjectId : null;
      const goals = collectGoals(ctx, session);
      const selectedGoal = activeProjectId
        ? goals.find((goal) => goal.active === true && goal.projectId === activeProjectId) ?? goals.find((goal) => goal.projectId === activeProjectId) ?? null
        : goals[0] ?? null;
      const snapshot = taskExecutionSnapshot(selectedGoal);
      const execution = await readTaskExecutionView(ctx.stateDir, snapshot);
      const roleContext = activeProjectId ? await buildActiveRoleContext(ctx, activeProjectId) : null;
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        execution,
        effectivePermission: roleContext?.effectivePermission ?? null,
        projectPermission: roleContext?.projectPermission ?? null,
      });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.get("/api/jk/control/logs", async (req, res) => {
    try {
      const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 80;
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 80;
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, logs: await readRecentAuditEvents(ctx.stateDir, limit) });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.get("/api/jk/control/notifications", async (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, notifications: await readNtfySettings(ctx.stateDir) });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.post("/api/jk/control/notifications", async (req, res) => {
    try {
      const body = z.object({
        enabled: z.boolean().optional(),
        baseUrl: z.string().max(500).optional(),
        topic: z.string().max(180).optional(),
        clickUrl: z.string().max(700).optional(),
      }).parse(req.body ?? {});
      const clickUrl = body.clickUrl || (() => {
        try { return ctx.config.publicUrl ? new URL(ctx.config.publicUrl).origin : ""; } catch { return ""; }
      })();
      const notifications = await saveNtfySettings(ctx.stateDir, { ...body, clickUrl });
      await ctx.ledger.append({ type: "notifications.ntfy.configured", enabled: notifications.enabled });
      res.json({ ok: true, notifications });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.post("/api/jk/control/notifications/test", async (_req, res) => {
    try {
      const delivered = await sendJkPush({
        kind: "success",
        projectId: "JK",
        reason: "모바일 푸시 테스트입니다. 앞으로 승인·완료·실패 알림이 여기로 옵니다.",
      }, process.env, ctx.stateDir);
      res.json({ ok: delivered, delivered });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.get("/api/jk/control/approvals", async (_req, res) => {
    try {
      const [approvals, jobs] = await Promise.all([
        listPendingLocalShellApprovals(ctx.stateDir),
        listRecentLocalShellJobs(ctx.stateDir, 20),
      ]);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, approvals, jobs });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.post("/api/jk/control/approvals/:id", async (req, res) => {
    try {
      const input = ResolveApprovalSchema.parse(req.body ?? {});
      const approval = await resolveLocalShellApproval(ctx.stateDir, req.params.id, input.decision);
      await ctx.ledger.append({
        type: "local.approval.resolved",
        projectId: approval.projectId,
        approvalId: approval.id,
        decision: input.decision,
      });
      let job = null;
      if (input.decision === "deny") {
        const denied = await markLocalShellJobDenied(ctx.stateDir, approval.id);
        if (denied) await updateJobTaskContinuation(ctx, denied, "denied");
        job = denied ? publicLocalShellJob(denied) : null;
      } else {
        job = await startApprovedLocalShellJob(ctx, approval.id);
      }
      res.json({ ok: true, approval, job });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.post("/api/jk/control/projects/:projectId/activate", async (req, res) => {
    try {
      const body = ActivateProjectSchema.parse(req.body ?? {});
      const projectId = await resolveCanonicalRoleProjectId(ctx, req.params.projectId);
      const remoteProjects = await getExecutorProjectRegistry(ctx.stateDir, ctx.registry);
      const entry = [...ctx.registry, ...remoteProjects].find((project) => project.projectId === projectId);
      if (!entry) throw new DomainError(ErrorCode.PROJECT_NOT_FOUND, `Project not found: ${req.params.projectId}`);
      const lease = makeLease(entry, body.preset);
      await updateSession(ctx, (current) => ({
        ...current,
        activeProjectId: entry.projectId,
        mode: modeForPreset(body.preset),
        lease,
      }));
      const roleContext = await buildActiveRoleContext(ctx, entry.projectId, body.preset);
      await ctx.ledger.append({
        type: "project.selected.web",
        projectId: entry.projectId,
        preset: body.preset,
        effectivePermission: roleContext.effectivePermission,
      });
      res.json({ ok: true, project: { projectId: entry.projectId, name: entry.name }, lease, roleContext });
    } catch (err) {
      sendApiError(res, err);
    }
  });
}

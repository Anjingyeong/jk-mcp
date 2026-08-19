import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { verifyOwnerToken } from "../auth/owner-token.js";
import { isLoopbackRequest } from "../server/loopback.js";
import type { ToolContext } from "../types.js";

const SESSION_COOKIE = "jk_owner_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_RUNTIME = 8;
const SESSION_STORE_FILE = "control-owner-sessions.json";

interface RemoteManagementConfig {
  host: string | null;
}

interface OwnerSession {
  tokenHash: string;
  expiresAt: number;
}

const sessionsByStateDir = new Map<string, OwnerSession[]>();
const loadedStateDirs = new Set<string>();

function normalizeHostname(value: string | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end >= 0 ? raw.slice(1, end) : raw;
  }
  return raw.split(":", 1)[0] ?? "";
}

function rawPeerIsLoopback(req: Request): boolean {
  const raw = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  return raw === "127.0.0.1" || raw === "::1";
}

export function remoteManagementConfig(): RemoteManagementConfig {
  const host = normalizeHostname(process.env.JK_REMOTE_MANAGEMENT_HOST);
  return { host: host || null };
}

function requestHostname(req: Request): string {
  if (rawPeerIsLoopback(req)) {
    const forwarded = req.get("x-forwarded-host");
    if (forwarded) return normalizeHostname(forwarded.split(",", 1)[0]);
  }
  return normalizeHostname(req.get("host"));
}

function isRemoteManagementRequest(req: Request): boolean {
  const config = remoteManagementConfig();
  return Boolean(config.host && requestHostname(req) === config.host);
}

function parseCookies(req: Request): Record<string, string> {
  const cookies: Record<string, string> = {};
  const header = req.get("cookie") ?? "";
  for (const item of header.split(";")) {
    const index = item.indexOf("=");
    if (index <= 0) continue;
    const name = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function sessionStorePath(stateDir: string): string {
  return path.join(stateDir, SESSION_STORE_FILE);
}

function loadSessionsIfNeeded(stateDir: string): void {
  if (loadedStateDirs.has(stateDir)) return;
  loadedStateDirs.add(stateDir);
  try {
    const parsed = JSON.parse(readFileSync(sessionStorePath(stateDir), "utf8")) as unknown;
    const now = Date.now();
    const sessions = Array.isArray(parsed)
      ? parsed.filter((value): value is OwnerSession => {
          if (!value || typeof value !== "object") return false;
          const item = value as Partial<OwnerSession>;
          return typeof item.tokenHash === "string" && item.tokenHash.length > 20 && typeof item.expiresAt === "number" && item.expiresAt > now;
        })
      : [];
    sessionsByStateDir.set(stateDir, sessions.slice(-MAX_SESSIONS_PER_RUNTIME));
  } catch {
    sessionsByStateDir.set(stateDir, []);
  }
}

function persistSessions(stateDir: string): void {
  const sessions = sessionsByStateDir.get(stateDir) ?? [];
  const target = sessionStorePath(stateDir);
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(sessions, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    // Login still works in-memory if persistence is unavailable. Never expose
    // session material or weaken authentication because of a filesystem issue.
  }
}

function pruneSessions(stateDir: string, now = Date.now()): OwnerSession[] {
  loadSessionsIfNeeded(stateDir);
  const current = (sessionsByStateDir.get(stateDir) ?? []).filter((session) => session.expiresAt > now);
  sessionsByStateDir.set(stateDir, current.slice(-MAX_SESSIONS_PER_RUNTIME));
  return current;
}

function hasOwnerSession(ctx: ToolContext, req: Request): boolean {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const tokenHash = hashToken(token);
  return pruneSessions(ctx.stateDir).some((session) => session.tokenHash === tokenHash);
}

function setOwnerSessionCookie(res: Response, token: string): void {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict`,
  );
}

function clearOwnerSessionCookie(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
  );
}

export function requireControlPageAccess(ctx: ToolContext) {
  return function controlPageAccess(req: Request, res: Response, next: NextFunction): void {
    if (isLoopbackRequest(req)) {
      next();
      return;
    }
    if (!isRemoteManagementRequest(req)) {
      res.status(403).json({ ok: false, error: "JK remote management is disabled for this host or blocked by the configured access gate." });
      return;
    }
    if (hasOwnerSession(ctx, req)) {
      next();
      return;
    }
    const returnTo = req.path === "/approvals" ? "/approvals" : "/";
    res.redirect(302, `/login?return=${encodeURIComponent(returnTo)}`);
  };
}

export function requireControlApiAccess(ctx: ToolContext) {
  return function controlApiAccess(req: Request, res: Response, next: NextFunction): void {
    if (isLoopbackRequest(req)) {
      next();
      return;
    }
    if (!isRemoteManagementRequest(req)) {
      res.status(403).json({ ok: false, error: "JK remote management is disabled for this host or blocked by the configured access gate." });
      return;
    }
    if (!hasOwnerSession(ctx, req)) {
      res.status(401).json({ ok: false, code: "OWNER_LOGIN_REQUIRED", error: "Owner login is required." });
      return;
    }
    next();
  };
}

export async function loginRemoteOwner(ctx: ToolContext, req: Request, res: Response): Promise<void> {
  if (isLoopbackRequest(req)) {
    res.status(400).json({ ok: false, error: "Owner login is only needed for remote management." });
    return;
  }
  if (!isRemoteManagementRequest(req)) {
    res.status(403).json({ ok: false, error: "Remote management is not enabled for this host." });
    return;
  }
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const candidate = typeof body.ownerToken === "string" ? body.ownerToken.trim() : "";
  if (!candidate || !(await verifyOwnerToken(ctx.stateDir, candidate))) {
    await ctx.ledger.append({ type: "control.owner_login", outcome: "denied" }).catch(() => undefined);
    res.status(401).json({ ok: false, error: "Owner token was not accepted." });
    return;
  }

  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const sessions = pruneSessions(ctx.stateDir, now);
  sessions.push({ tokenHash: hashToken(token), expiresAt: now + SESSION_TTL_MS });
  sessionsByStateDir.set(ctx.stateDir, sessions.slice(-MAX_SESSIONS_PER_RUNTIME));
  persistSessions(ctx.stateDir);
  setOwnerSessionCookie(res, token);
  await ctx.ledger.append({ type: "control.owner_login", outcome: "accepted" }).catch(() => undefined);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, expiresAt: now + SESSION_TTL_MS });
}

export function logoutRemoteOwner(ctx: ToolContext, req: Request, res: Response): void {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    const tokenHash = hashToken(token);
    const remaining = pruneSessions(ctx.stateDir).filter((session) => session.tokenHash !== tokenHash);
    sessionsByStateDir.set(ctx.stateDir, remaining);
    persistSessions(ctx.stateDir);
  }
  clearOwnerSessionCookie(res);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
}

export function canServeRemoteLogin(req: Request): boolean {
  if (isLoopbackRequest(req)) return true;
  return isRemoteManagementRequest(req);
}

export const CONTROL_CENTER_LOGIN_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>JK Owner Login</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#0b0d10;color:#f4f4f5}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(420px,100%);border:1px solid #2a2f37;border-radius:20px;background:#12151a;padding:28px;box-shadow:0 22px 70px #0008}.brand{font-size:13px;color:#9aa3af;letter-spacing:.12em;text-transform:uppercase}.title{font-size:26px;font-weight:750;margin:10px 0 8px}.desc{color:#aab1bb;line-height:1.55;margin:0 0 22px}label{display:block;font-size:13px;color:#c8ced7;margin:0 0 8px}input{width:100%;border:1px solid #343b45;background:#0c0f13;color:#fff;border-radius:12px;padding:13px 14px;font:inherit;outline:none}input:focus{border-color:#77808d}button{width:100%;margin-top:14px;border:0;border-radius:12px;padding:13px 14px;font:inherit;font-weight:700;cursor:pointer;background:#f4f4f5;color:#0b0d10}.status{min-height:22px;margin-top:12px;color:#f0a6a6;font-size:13px}.note{margin-top:18px;color:#727b87;font-size:12px;line-height:1.5}</style>
</head>
<body><main class="card"><div class="brand">JK Remote Owner</div><div class="title">관리자 로그인</div><p class="desc">관리자 키는 최초 로그인에만 사용합니다. 성공 후에는 30일 HttpOnly 세션을 유지하며 JK가 재시작되어도 세션을 복원합니다.</p><form id="login-form"><label for="owner-token">관리자 키</label><input id="owner-token" name="owner-token" type="password" autocomplete="current-password" autofocus required /><button type="submit">로그인</button><div id="status" class="status" role="status"></div></form><div class="note">JK는 127.0.0.1에만 바인딩됩니다. 원격 관리는 별도로 구성한 reverse proxy 또는 tunnel과 owner 인증을 함께 사용하세요.</div></main><script>
const form=document.getElementById('login-form');const input=document.getElementById('owner-token');const status=document.getElementById('status');
form.addEventListener('submit',async(e)=>{e.preventDefault();status.textContent='';const ownerToken=input.value;try{const res=await fetch('/api/jk/control/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ownerToken})});const body=await res.json();if(!res.ok)throw new Error(body.error||'로그인 실패');input.value='';const requested=new URLSearchParams(location.search).get('return')||'/';location.href=requested.startsWith('/')&&!requested.startsWith('//')?requested:'/';}catch(err){status.textContent=err.message||'로그인 실패';}});
</script></body></html>`;

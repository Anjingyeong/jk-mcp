import type { NextFunction, Request, Response } from "express";

function normalizeIp(value: string | undefined): string {
  if (!value) return "";
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

export function isLoopbackRequest(req: Request): boolean {
  const ip = normalizeIp(req.ip || req.socket.remoteAddress);
  return ip === "127.0.0.1" || ip === "::1";
}

export function requireLoopback(req: Request, res: Response, next: NextFunction): void {
  if (isLoopbackRequest(req)) {
    next();
    return;
  }
  res.status(403).json({ ok: false, error: "JK local management is available only from this machine." });
}

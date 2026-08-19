import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";

const EXECUTOR_CREDENTIALS_FILE = "executor-credentials.json";
const VERSION = 1;

interface CredentialRecord {
  tokenHash: string;
  createdAt: number;
}

interface CredentialState {
  version: number;
  updatedAt: number;
  credentials: Record<string, CredentialRecord>;
}

function validateExecutorId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id)) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid executor id", { executorId: value });
  }
  return id;
}

function statePath(stateDir: string): string {
  return path.join(stateDir, EXECUTOR_CREDENTIALS_FILE);
}

async function loadState(stateDir: string): Promise<CredentialState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(stateDir), "utf8")) as Partial<CredentialState>;
    return {
      version: VERSION,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      credentials: parsed.credentials && typeof parsed.credentials === "object"
        ? parsed.credentials as Record<string, CredentialRecord>
        : {},
    };
  } catch {
    return { version: VERSION, updatedAt: Date.now(), credentials: {} };
  }
}

async function saveState(stateDir: string, state: CredentialState): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = statePath(stateDir);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify({ ...state, version: VERSION, updatedAt: Date.now() }, null, 2)}\n`;
  await writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function issueExecutorToken(stateDir: string, executorId: string): Promise<string> {
  const id = validateExecutorId(executorId);
  const token = `jkexec_${randomBytes(32).toString("base64url")}`;
  const state = await loadState(stateDir);
  state.credentials[id] = { tokenHash: tokenHash(token), createdAt: Date.now() };
  await saveState(stateDir, state);
  return token;
}

export async function verifyExecutorToken(stateDir: string, executorId: string, token: string): Promise<boolean> {
  const id = validateExecutorId(executorId);
  if (!token.startsWith("jkexec_") || token.length < 32) return false;
  const record = (await loadState(stateDir)).credentials[id];
  if (!record?.tokenHash) return false;
  const expected = Buffer.from(record.tokenHash, "hex");
  const actual = Buffer.from(tokenHash(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function revokeExecutorToken(stateDir: string, executorId: string): Promise<boolean> {
  const id = validateExecutorId(executorId);
  const state = await loadState(stateDir);
  if (!state.credentials[id]) return false;
  delete state.credentials[id];
  await saveState(stateDir, state);
  return true;
}

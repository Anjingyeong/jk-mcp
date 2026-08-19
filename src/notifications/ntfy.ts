import { promises as fs } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

export type JkPushKind = "approval" | "success" | "failure";

export interface JkPushEvent {
  kind: JkPushKind;
  projectId: string;
  reason?: string | null;
}

export interface NtfyConfig {
  baseUrl: string;
  topic: string;
  clickBaseUrl?: string;
}

export interface NtfySettingsView {
  enabled: boolean;
  baseUrl: string;
  topic: string;
  clickUrl: string;
}

function cleanText(value: string | null | undefined, max = 180): string {
  return (value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}

export function readNtfyConfig(env: NodeJS.ProcessEnv = process.env): NtfyConfig | null {
  const topic = cleanText(env.JK_NTFY_TOPIC, 160);
  if (!topic || !/^[A-Za-z0-9_-]+$/.test(topic)) return null;

  const baseUrl = cleanText(env.JK_NTFY_BASE_URL || "https://ntfy.sh", 400).replace(/\/+$/, "");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }

  const rawClick = cleanText(env.JK_NTFY_CLICK_URL, 600);
  let clickBaseUrl: string | undefined;
  if (rawClick) {
    try {
      const parsed = new URL(rawClick);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") clickBaseUrl = parsed.toString().replace(/\/+$/, "");
    } catch {
      // Invalid click URLs are ignored; push delivery itself can still work.
    }
  }

  return { baseUrl, topic, clickBaseUrl };
}

export async function readNtfyConfigForState(
  stateDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NtfyConfig | null> {
  const fromEnv = readNtfyConfig(env);
  if (fromEnv || !stateDir) return fromEnv;
  try {
    const raw = JSON.parse(await fs.readFile(path.join(stateDir, "notifications", "ntfy.json"), "utf8")) as {
      baseUrl?: string;
      topic?: string;
      clickUrl?: string;
    };
    return readNtfyConfig({
      JK_NTFY_BASE_URL: raw.baseUrl,
      JK_NTFY_TOPIC: raw.topic,
      JK_NTFY_CLICK_URL: raw.clickUrl,
    });
  } catch {
    return null;
  }
}

function settingsPath(stateDir: string): string {
  return path.join(stateDir, "notifications", "ntfy.json");
}

export async function readNtfySettings(stateDir: string, env: NodeJS.ProcessEnv = process.env): Promise<NtfySettingsView> {
  const config = await readNtfyConfigForState(stateDir, env);
  return config
    ? { enabled: true, baseUrl: config.baseUrl, topic: config.topic, clickUrl: config.clickBaseUrl ?? "" }
    : { enabled: false, baseUrl: "https://ntfy.sh", topic: "", clickUrl: "" };
}

export async function saveNtfySettings(
  stateDir: string,
  input: { enabled?: boolean; baseUrl?: string; topic?: string; clickUrl?: string },
): Promise<NtfySettingsView> {
  const target = settingsPath(stateDir);
  if (input.enabled === false) {
    await fs.unlink(target).catch(() => undefined);
    return { enabled: false, baseUrl: "https://ntfy.sh", topic: "", clickUrl: "" };
  }

  const generatedTopic = `jk_${randomBytes(24).toString("base64url")}`;
  const config = readNtfyConfig({
    JK_NTFY_BASE_URL: input.baseUrl || "https://ntfy.sh",
    JK_NTFY_TOPIC: input.topic?.trim() || generatedTopic,
    JK_NTFY_CLICK_URL: input.clickUrl || "",
  });
  if (!config) throw new Error("Invalid ntfy notification settings");

  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  const temp = path.join(dir, `.ntfy.${randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify({ baseUrl: config.baseUrl, topic: config.topic, clickUrl: config.clickBaseUrl ?? "" }, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(temp, 0o600).catch(() => undefined);
  await fs.rename(temp, target);
  return { enabled: true, baseUrl: config.baseUrl, topic: config.topic, clickUrl: config.clickBaseUrl ?? "" };
}

function clickUrl(config: NtfyConfig, kind: JkPushKind): string | undefined {
  if (!config.clickBaseUrl) return undefined;
  try {
    const base = new URL(config.clickBaseUrl);
    if (kind === "approval") base.pathname = "/approvals";
    return base.toString();
  } catch {
    return undefined;
  }
}

export function ntfyPayload(config: NtfyConfig, event: JkPushEvent): Record<string, unknown> {
  const project = cleanText(event.projectId, 100) || "JK";
  const reason = cleanText(event.reason, 180);
  const common = {
    topic: config.topic,
    click: clickUrl(config, event.kind),
  };

  if (event.kind === "approval") {
    return {
      ...common,
      title: `JK 승인 필요 · ${project}`,
      message: reason || "승인이 필요한 작업이 대기 중입니다.",
      priority: 5,
      tags: ["warning", "lock"],
    };
  }
  if (event.kind === "failure") {
    return {
      ...common,
      title: `JK 작업 실패 · ${project}`,
      message: reason || "작업이 실패했습니다. JK에서 결과를 확인하세요.",
      priority: 5,
      tags: ["x", "warning"],
    };
  }
  return {
    ...common,
    title: `JK 작업 완료 · ${project}`,
    message: reason || "작업이 정상적으로 완료됐습니다.",
    priority: 3,
    tags: ["white_check_mark"],
  };
}

/** Best-effort mobile push. Notification failures never fail the underlying JK job. */
export async function sendJkPush(
  event: JkPushEvent,
  env: NodeJS.ProcessEnv = process.env,
  stateDir?: string,
): Promise<boolean> {
  const config = await readNtfyConfigForState(stateDir, env);
  if (!config) return false;

  try {
    const response = await fetch(`${config.baseUrl}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ntfyPayload(config, event)),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      console.warn(`[JK push] ntfy returned HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[JK push] ntfy delivery failed: ${(err as Error).message}`);
    return false;
  }
}

export type JkPushOnceResult = "delivered" | "duplicate" | "failed";

/** Persisted, atomic best-effort dedupe for terminal notifications. Failed deliveries release the claim so a later retry can succeed. */
export async function sendJkPushOnce(
  stateDir: string,
  dedupeKey: string,
  event: JkPushEvent,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JkPushOnceResult> {
  const keyHash = createHash("sha256").update(dedupeKey).digest("hex");
  const dir = path.join(stateDir, "notifications", "delivered");
  const receipt = path.join(dir, `${keyHash}.json`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  try {
    await fs.writeFile(receipt, `${JSON.stringify({ keyHash, claimedAt: new Date().toISOString() })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "duplicate";
    throw err;
  }

  const delivered = await sendJkPush(event, env, stateDir);
  if (delivered) return "delivered";
  await fs.unlink(receipt).catch(() => undefined);
  return "failed";
}

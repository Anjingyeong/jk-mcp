import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ntfyPayload, readNtfyConfig, readNtfySettings, saveNtfySettings, sendJkPush, sendJkPushOnce } from "./ntfy.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("JK ntfy notifications", () => {
  it("stays disabled unless a valid topic is configured", () => {
    expect(readNtfyConfig({})).toBeNull();
    expect(readNtfyConfig({ JK_NTFY_TOPIC: "bad/topic" })).toBeNull();
    expect(readNtfyConfig({ JK_NTFY_TOPIC: "jk_mobile_123" })).toMatchObject({
      baseUrl: "https://ntfy.sh",
      topic: "jk_mobile_123",
    });
  });

  it("builds safe approval and terminal-state payloads", () => {
    const config = readNtfyConfig({
      JK_NTFY_TOPIC: "jk_mobile_123",
      JK_NTFY_CLICK_URL: "https://jk.example.com/",
    });
    expect(config).not.toBeNull();

    expect(ntfyPayload(config!, {
      kind: "approval",
      projectId: "example-app",
      reason: "Deploy\nrequires approval",
    })).toMatchObject({
      topic: "jk_mobile_123",
      title: "JK 승인 필요 · example-app",
      message: "Deploy requires approval",
      priority: 5,
      click: "https://jk.example.com/approvals",
    });

    expect(ntfyPayload(config!, { kind: "success", projectId: "example-service" })).toMatchObject({
      title: "JK 작업 완료 · example-service",
      priority: 3,
      click: "https://jk.example.com/",
    });

    expect(ntfyPayload(config!, { kind: "failure", projectId: "JK" })).toMatchObject({
      title: "JK 작업 실패 · JK",
      priority: 5,
    });
  });

  it("publishes as ntfy JSON and never throws on delivery failure", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockRejectedValueOnce(new Error("offline"));
    const env = {
      JK_NTFY_TOPIC: "jk_mobile_123",
      JK_NTFY_BASE_URL: "https://ntfy.sh/",
      JK_NTFY_CLICK_URL: "https://jk.example.com",
    };

    await expect(sendJkPush({ kind: "approval", projectId: "example-app" }, env)).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://ntfy.sh/");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({ topic: "jk_mobile_123", priority: 5 });

    await expect(sendJkPush({ kind: "failure", projectId: "example-app" }, env)).resolves.toBe(false);
  });

  it("generates and stores a private topic in JK state, then disables cleanly", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "jk-ntfy-"));
    const enabled = await saveNtfySettings(stateDir, { enabled: true, clickUrl: "https://jk.example.com" });
    expect(enabled.enabled).toBe(true);
    expect(enabled.topic).toMatch(/^jk_[A-Za-z0-9_-]{20,}$/);
    expect(await readNtfySettings(stateDir, {})).toEqual(enabled);
    expect((await stat(path.join(stateDir, "notifications", "ntfy.json"))).mode & 0o777).toBe(0o600);

    await saveNtfySettings(stateDir, { enabled: false });
    expect((await readNtfySettings(stateDir, {})).enabled).toBe(false);
  });

  it("deduplicates terminal pushes atomically and retries after a failed delivery", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "jk-ntfy-once-"));
    const env = { JK_NTFY_TOPIC: "jk_mobile_123" };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await expect(sendJkPushOnce(stateDir, "goal:1:success", { kind: "success", projectId: "proj" }, env)).resolves.toBe("delivered");
    await expect(sendJkPushOnce(stateDir, "goal:1:success", { kind: "success", projectId: "proj" }, env)).resolves.toBe("duplicate");
    await expect(sendJkPushOnce(stateDir, "goal:2:failure", { kind: "failure", projectId: "proj" }, env)).resolves.toBe("failed");
    await expect(sendJkPushOnce(stateDir, "goal:2:failure", { kind: "failure", projectId: "proj" }, env)).resolves.toBe("delivered");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

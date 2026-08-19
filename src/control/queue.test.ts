import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, ErrorCode } from "../types.js";
import {
  approveAction,
  clearKill,
  enqueue,
  getAction,
  isKilled,
  listActions,
  markDone,
  rejectAction,
  setKill,
  textSummaryFor,
  toSummary,
} from "./queue.js";
import { readAuto, setAuto } from "./auto.js";

describe("control/queue", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-control-queue-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("enqueues a pending action and never auto-executes it", async () => {
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      reason: "test",
    });
    expect(record.status).toBe("pending");

    const fetched = await getAction(stateDir, record.actionId);
    expect(fetched?.status).toBe("pending");
    expect(fetched?.result).toBeUndefined();
  });

  it("redacts raw text into a length+hash summary, never the original characters", async () => {
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "type",
      target: { windowPoint: { xRel: 0.5, yRel: 0.5 } },
      text: "super-secret-password",
      reason: "test",
    });
    const summary = toSummary(record);
    expect((summary as unknown as { text?: string }).text).toBeUndefined();
    expect(summary.textSummary).toEqual(textSummaryFor("super-secret-password"));
    expect(JSON.stringify(summary)).not.toContain("super-secret-password");
  });

  it("approve moves pending -> approved, then markDone moves approved -> done", async () => {
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "key",
      target: {},
      keyCode: 36,
      reason: "test",
    });
    const approved = await approveAction(stateDir, record.actionId);
    expect(approved.status).toBe("approved");

    const done = await markDone(stateDir, record.actionId, { ok: true });
    expect(done.status).toBe("done");
    expect(done.result?.ok).toBe(true);

    const all = await listActions(stateDir);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("done");
  });

  it("rejects a pending action and refuses to approve an already-rejected one", async () => {
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.1, yRel: 0.1 } },
      reason: "test",
    });
    const rejected = await rejectAction(stateDir, record.actionId, "user-declined");
    expect(rejected.status).toBe("rejected");
    expect(rejected.result?.error).toBe("user-declined");

    await expect(approveAction(stateDir, record.actionId)).rejects.toThrow(DomainError);
  });

  it("expires a pending action past its TTL into rejected", async () => {
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "click",
      target: { windowPoint: { xRel: 0.1, yRel: 0.1 } },
      reason: "test",
      ttlMs: -1,
    });
    const fetched = await getAction(stateDir, record.actionId);
    expect(fetched?.status).toBe("rejected");
    expect(fetched?.result?.error).toBe("expired");
  });

  it("kill switch rejects all pending actions and blocks new enqueue until cleared", async () => {
    const a = await enqueue(stateDir, { appName: "TextEdit", kind: "click", target: { windowPoint: { xRel: 0, yRel: 0 } }, reason: "a" });
    const b = await enqueue(stateDir, { appName: "TextEdit", kind: "click", target: { windowPoint: { xRel: 0, yRel: 0 } }, reason: "b" });

    await setKill(stateDir);
    expect(await isKilled(stateDir)).toBe(true);

    const fetchedA = await getAction(stateDir, a.actionId);
    const fetchedB = await getAction(stateDir, b.actionId);
    expect(fetchedA?.status).toBe("rejected");
    expect(fetchedB?.status).toBe("rejected");

    await expect(
      enqueue(stateDir, { appName: "TextEdit", kind: "click", target: { windowPoint: { xRel: 0, yRel: 0 } }, reason: "c" }),
    ).rejects.toMatchObject({ code: ErrorCode.CONTROL_KILLED });

    await clearKill(stateDir);
    expect(await isKilled(stateDir)).toBe(false);
    const c = await enqueue(stateDir, { appName: "TextEdit", kind: "click", target: { windowPoint: { xRel: 0, yRel: 0 } }, reason: "c" });
    expect(c.status).toBe("pending");
  });

  it("getAction returns null for an unknown actionId", async () => {
    expect(await getAction(stateDir, "ctl_does-not-exist")).toBeNull();
  });

  it("refuses a path-traversal actionId and never reads a file outside the control state dir (computer_action_status guard)", async () => {
    // Plant a real, parseable JSON file exactly where a traversal actionId
    // would resolve to (three levels up from stateDir/control/pending, i.e.
    // the OS tmpdir this stateDir lives under) — if the format guard were
    // absent, this is exactly the arbitrary-file-disclosure the finding
    // describes: any file that exists, ends in .json, and parses as JSON.
    const outsidePath = path.join(path.dirname(stateDir), `chatgpt2codex-queue-traversal-secret-${Date.now()}.json`);
    await fs.writeFile(
      outsidePath,
      JSON.stringify({ actionId: "ctl_00000000-0000-0000-0000-000000000000", status: "done", leaked: "SHOULD-NEVER-SURFACE" }),
    );
    try {
      const traversalId = `../../../${path.basename(outsidePath, ".json")}`;
      expect(await getAction(stateDir, traversalId)).toBeNull();
      expect(await getAction(stateDir, "../../../etc/passwd")).toBeNull();
      expect(await getAction(stateDir, "../../etc/hosts")).toBeNull();
      expect(await getAction(stateDir, "/etc/passwd")).toBeNull();
      // Not a path at all, but also not the issued ctl_<uuid> format.
      expect(await getAction(stateDir, "ctl_not-a-uuid")).toBeNull();
      // Nothing was ever enqueued, so the (correctly empty) queue also
      // proves no traversal read got promoted into a real record.
      expect(await listActions(stateDir)).toEqual([]);
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it("approveAction defaults approvedVia to 'human', and accepts an explicit 'auto' marker", async () => {
    const a = await enqueue(stateDir, { appName: "TextEdit", kind: "click", target: {}, reason: "a" });
    const approvedA = await approveAction(stateDir, a.actionId);
    expect(approvedA.approvedVia).toBe("human");

    const b = await enqueue(stateDir, { appName: "TextEdit", kind: "click", target: {}, reason: "b" });
    const approvedB = await approveAction(stateDir, b.actionId, { approvedVia: "auto" });
    expect(approvedB.approvedVia).toBe("auto");
  });

  it("setKill clears any active auto-approve scope in addition to rejecting pending actions", async () => {
    process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST = "TextEdit";
    await setAuto(stateDir, { apps: ["TextEdit"], minutes: 10 });
    expect(await readAuto(stateDir)).not.toBeNull();

    await setKill(stateDir);

    expect(await readAuto(stateDir)).toBeNull();
    delete process.env.CHATGPT2CODEX_CONTROL_ALLOWLIST;
  });

  it("persists and surfaces the read-only AX resolve preview via toSummary, alongside the redacted text", async () => {
    const record = await enqueue(stateDir, {
      appName: "TextEdit",
      kind: "type",
      target: { ax: { role: "textField", title: "Name" } },
      text: "super-secret-password",
      reason: "test",
      resolved: {
        found: true,
        role: "textField",
        title: "Name",
        frame: { x: 10, y: 20, width: 100, height: 24 },
        app: "TextEdit",
        matchCount: 1,
        source: "system-events",
      },
    });
    expect(record.resolved?.found).toBe(true);

    const fetched = await getAction(stateDir, record.actionId);
    expect(fetched?.resolved).toEqual(record.resolved);

    const summary = toSummary(record);
    expect(summary.resolved).toEqual(record.resolved);
    expect(JSON.stringify(summary)).not.toContain("super-secret-password");
  });

  it("still round-trips when resolve found no accessibility match (dry-run preview surfaces the reason, not an error)", async () => {
    const record = await enqueue(stateDir, {
      appName: "SomeElectronApp",
      kind: "click",
      target: { ax: { role: "button", title: "Send" }, windowPoint: { xRel: 0.5, yRel: 0.9 } },
      reason: "test",
      resolved: { found: false, reason: "empty/opt-out AX tree", source: "ax-helper" },
    });
    const summary = toSummary(record);
    expect(summary.resolved).toEqual({ found: false, reason: "empty/opt-out AX tree", source: "ax-helper" });
  });
});

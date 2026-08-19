import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeLocalShellApproval,
  listPendingLocalShellApprovals,
  requestLocalShellApproval,
  resolveLocalShellApproval,
  type LocalShellApprovalInput,
} from "./local-approvals.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jk-shell-approval-"));
  tempDirs.push(dir);
  return dir;
}

function input(overrides: Partial<LocalShellApprovalInput> = {}): LocalShellApprovalInput {
  return {
    projectId: "proj",
    command: "git fetch origin",
    cwd: ".",
    reason: "Refresh remote refs",
    needsNetwork: true,
    destructive: false,
    ...overrides,
  };
}

describe("local shell approvals", () => {
  it("creates a pending exact-command approval with a bounded preview", async () => {
    const dir = await stateDir();
    const record = await requestLocalShellApproval(dir, input());
    expect(record.status).toBe("pending");
    expect(record.id).toMatch(/^[a-f0-9]{64}$/);
    expect(record.commandPreview).toContain("git fetch origin");
    expect(record.expiresAt).toBeGreaterThan(record.createdAt);

    const pending = await listPendingLocalShellApprovals(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(record.id);
  });

  it("approves exactly once and consumes the grant atomically", async () => {
    const dir = await stateDir();
    const requested = await requestLocalShellApproval(dir, input());
    const approved = await resolveLocalShellApproval(dir, requested.id, "approve");
    expect(approved.status).toBe("approved");
    expect(await consumeLocalShellApproval(dir, input())).toBe(true);
    expect(await consumeLocalShellApproval(dir, input())).toBe(false);
  });

  it("does not let approval for one command authorize a different command", async () => {
    const dir = await stateDir();
    const requested = await requestLocalShellApproval(dir, input());
    await resolveLocalShellApproval(dir, requested.id, "approve");
    expect(await consumeLocalShellApproval(dir, input({ command: "git fetch --all" }))).toBe(false);
    expect(await consumeLocalShellApproval(dir, input())).toBe(true);
  });

  it("persists a denial for the same unexpired exact request", async () => {
    const dir = await stateDir();
    const requested = await requestLocalShellApproval(dir, input());
    const denied = await resolveLocalShellApproval(dir, requested.id, "deny");
    expect(denied.status).toBe("denied");
    const repeated = await requestLocalShellApproval(dir, input());
    expect(repeated.status).toBe("denied");
    expect(await consumeLocalShellApproval(dir, input())).toBe(false);
  });

  it("turns an approved read-only scope into a reusable short session", async () => {
    const dir = await stateDir();
    const scoped = input({
      command: "aws freetier get-free-tier-usage --region us-east-1",
      scope: { key: "network-read:aws-inventory", label: "AWS read-only inventory", ttlMs: 15 * 60 * 1000 },
    });
    const requested = await requestLocalShellApproval(dir, scoped);
    expect(requested.scopeLabel).toBe("AWS read-only inventory");
    await resolveLocalShellApproval(dir, requested.id, "approve");

    expect(await consumeLocalShellApproval(dir, scoped)).toBe(true);
    expect(
      await consumeLocalShellApproval(
        dir,
        input({
          command: "aws ec2 describe-instance-types --region ap-northeast-2",
          scope: { key: "network-read:aws-inventory", label: "AWS read-only inventory" },
        }),
      ),
    ).toBe(true);
    expect(
      await consumeLocalShellApproval(
        dir,
        input({
          command: "curl https://example.com",
          scope: { key: "network-read:http:https://example.com", label: "HTTP read-only · https://example.com" },
        }),
      ),
    ).toBe(false);
  });

  it("never turns a destructive approval into a reusable scope", async () => {
    const dir = await stateDir();
    const destructive = input({
      command: "Remove-Item .\\build\\old -Recurse -Force",
      needsNetwork: false,
      destructive: true,
      scope: { key: "network-read:aws-inventory", label: "should not persist" },
    });
    const requested = await requestLocalShellApproval(dir, destructive);
    await resolveLocalShellApproval(dir, requested.id, "approve");
    expect(await consumeLocalShellApproval(dir, destructive)).toBe(true);
    expect(
      await consumeLocalShellApproval(
        dir,
        input({
          command: "Remove-Item .\\build\\other -Recurse -Force",
          needsNetwork: false,
          destructive: true,
          scope: { key: "network-read:aws-inventory", label: "should not persist" },
        }),
      ),
    ).toBe(false);
  });

  it("reuses a task bundle only for predeclared exact command and risk hashes", async () => {
    const dir = await stateDir();
    const taskIdentity = "goal:example-release";
    const firstCommand = "gh release upload android-channel app.apk --clobber";
    const secondCommand = "gh release upload android-channel android-latest.json --clobber";
    const verifyCommand = "curl -I https://example.com/releases/latest.apk";
    const first = input({
      command: firstCommand,
      taskIdentity,
      destructive: true,
      bundle: {
        label: "Example stable release",
        entries: [
          { command: firstCommand, needsNetwork: true, destructive: true },
          { command: secondCommand, needsNetwork: true, destructive: true },
          { command: verifyCommand, needsNetwork: true, destructive: false },
        ],
      },
    });
    const requested = await requestLocalShellApproval(dir, first);
    expect(requested.bundleLabel).toBe("Example stable release");
    expect(requested.bundleCommandKeys).toHaveLength(3);
    await resolveLocalShellApproval(dir, requested.id, "approve");

    expect(await consumeLocalShellApproval(dir, first)).toBe(true);
    expect(await consumeLocalShellApproval(dir, input({ command: secondCommand, taskIdentity, destructive: true }))).toBe(true);
    expect(await consumeLocalShellApproval(dir, input({ command: verifyCommand, taskIdentity }))).toBe(true);
    expect(await consumeLocalShellApproval(dir, input({ command: "gh release delete android-channel --yes", taskIdentity, destructive: true }))).toBe(false);
    expect(await consumeLocalShellApproval(dir, input({ command: secondCommand, taskIdentity: "goal:other-release", destructive: true }))).toBe(false);
    expect(await consumeLocalShellApproval(dir, input({ command: secondCommand, taskIdentity, destructive: false }))).toBe(false);
  });

  it("reuses a supervised grant only for the same non-destructive network task", async () => {
    const dir = await stateDir();
    const taskReason = "Complete AWS JK deployment within verified free-tier guardrails";
    const first = input({
      command: "powershell -File scripts/deploy-jk-aws.ps1",
      reason: taskReason,
    });
    const requested = await requestLocalShellApproval(dir, first);
    const approved = await resolveLocalShellApproval(dir, requested.id, "supervise");
    expect(approved.status).toBe("approved");

    const retry = input({
      command: "powershell -File scripts/deploy-jk-aws.ps1 -Retry",
      reason: taskReason,
    });
    expect(await consumeLocalShellApproval(dir, retry)).toBe(true);
    expect(await consumeLocalShellApproval(dir, retry)).toBe(true);

    expect(
      await consumeLocalShellApproval(
        dir,
        input({ command: retry.command, reason: "Different task" }),
      ),
    ).toBe(false);
    expect(
      await consumeLocalShellApproval(
        dir,
        input({ command: retry.command, reason: taskReason, projectId: "other-project" }),
      ),
    ).toBe(false);
    expect(
      await consumeLocalShellApproval(
        dir,
        input({ command: retry.command, reason: taskReason, cwd: "subdir" }),
      ),
    ).toBe(false);
    expect(
      await consumeLocalShellApproval(
        dir,
        input({ command: retry.command, reason: taskReason, destructive: true }),
      ),
    ).toBe(false);
  });

  it("reuses a supervised grant by stable task identity even when the reason text changes", async () => {
    const dir = await stateDir();
    const first = input({
      command: "npx wrangler pages deploy dist --project-name example-vibe",
      reason: "Deploy the vibe portfolio",
      taskIdentity: "loop:vibe-release",
    });
    const requested = await requestLocalShellApproval(dir, first);
    await resolveLocalShellApproval(dir, requested.id, "supervise");

    expect(
      await consumeLocalShellApproval(
        dir,
        input({
          command: "curl -I https://vibe.example.com",
          reason: "Verify the live portfolio",
          taskIdentity: "loop:vibe-release",
        }),
      ),
    ).toBe(true);

    expect(
      await consumeLocalShellApproval(
        dir,
        input({
          command: "curl -I https://vibe.example.com",
          reason: "Deploy the vibe portfolio",
          taskIdentity: "loop:other-release",
        }),
      ),
    ).toBe(false);
  });

  it("does not persist a supervised grant for destructive work", async () => {
    const dir = await stateDir();
    const taskReason = "Dangerous cleanup task";
    const destructive = input({
      command: "Remove-Item .\\build\\old -Recurse -Force",
      reason: taskReason,
      needsNetwork: false,
      destructive: true,
    });
    const requested = await requestLocalShellApproval(dir, destructive);
    await resolveLocalShellApproval(dir, requested.id, "supervise");
    expect(await consumeLocalShellApproval(dir, destructive)).toBe(true);
    expect(
      await consumeLocalShellApproval(
        dir,
        input({
          command: "Remove-Item .\\build\\other -Recurse -Force",
          reason: taskReason,
          needsNetwork: false,
          destructive: true,
        }),
      ),
    ).toBe(false);
  });

  it("reuses only an explicitly bounded JK maintenance scope for destructive runtime maintenance", async () => {
    const dir = await stateDir();
    const maintenance = input({
      command: "bash scripts/reload-jk-runtime.sh",
      reason: "Apply verified JK runtime changes",
      needsNetwork: false,
      destructive: true,
      scope: { key: "maintenance:jk:runtime-reload", label: "JK runtime maintenance", ttlMs: 15 * 60 * 1000 },
    });
    const requested = await requestLocalShellApproval(dir, maintenance);
    expect(requested.scopeLabel).toBe("JK runtime maintenance");
    await resolveLocalShellApproval(dir, requested.id, "approve");

    expect(await consumeLocalShellApproval(dir, maintenance)).toBe(true);
    expect(
      await consumeLocalShellApproval(
        dir,
        input({
          command: "sh ./scripts/reload-jk-runtime.sh",
          reason: maintenance.reason,
          needsNetwork: false,
          destructive: true,
          scope: { key: "maintenance:jk:runtime-reload", label: "JK runtime maintenance" },
        }),
      ),
    ).toBe(true);
    expect(
      await consumeLocalShellApproval(
        dir,
        input({
          command: "Remove-Item .\\build\\other -Recurse -Force",
          reason: maintenance.reason,
          needsNetwork: false,
          destructive: true,
          scope: { key: "maintenance:other", label: "not JK maintenance" },
        }),
      ),
    ).toBe(false);
  });
});

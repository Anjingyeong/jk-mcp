import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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

  it("reuses a task bundle only for predeclared command and risk hashes", async () => {
    const dir = await stateDir();
    const workSessionId = "ws_cleantube_release";
    const taskIdentity = `goal:cleantube-release:work-session:${workSessionId}`;
    const releaseUpload = "gh release upload android-channel CleanTube-Android-0.1.12.apk --clobber";
    const manifestUpload = "gh release upload android-channel android-latest.json --clobber";
    const verify = "curl -I https://updates.example.com/android/latest.apk";
    const first = {
      ...input({
      command: releaseUpload,
      reason: "Publish CleanTube Android stable release",
      taskIdentity,
      destructive: true,
      bundle: {
        label: "CleanTube v0.1.12 stable release",
        entries: [
          { command: releaseUpload, needsNetwork: true, destructive: true },
          { command: manifestUpload, needsNetwork: true, destructive: true },
          { command: verify, needsNetwork: true, destructive: false },
        ],
      },
      }),
      workSessionId,
    } satisfies LocalShellApprovalInput & { workSessionId: string };
    const requested = await requestLocalShellApproval(dir, first);
    expect(requested.bundleLabel).toBe("CleanTube v0.1.12 stable release");
    expect(requested.bundleCommandKeys).toHaveLength(3);
    expect(requested).toMatchObject({
      workSessionId,
      bundleFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(requested.bundlePreviews).toEqual(expect.arrayContaining([
      expect.stringContaining("[destructive] gh release upload"),
      expect.stringContaining("[network] curl -I"),
    ]));
    await resolveLocalShellApproval(dir, requested.id, "approve");

    const bundleFiles = await readdir(path.join(dir, "approvals", "shell", "task-bundles"));
    expect(bundleFiles).toHaveLength(1);
    const bundleRecord = JSON.parse(
      await readFile(path.join(dir, "approvals", "shell", "task-bundles", bundleFiles[0]!), "utf8"),
    ) as {
      approvalId?: string;
      bundleFingerprint?: string;
      workSessionId?: string;
      remainingCommandKeys?: string[];
    };
    expect(bundleRecord).toMatchObject({
      approvalId: requested.id,
      bundleFingerprint: requested.bundleFingerprint,
      workSessionId,
    });
    expect(bundleRecord.remainingCommandKeys).toHaveLength(3);

    expect(await consumeLocalShellApproval(dir, first)).toBe(true);
    expect(await consumeLocalShellApproval(dir, first)).toBe(false);
    const manifest = {
      ...input({ command: manifestUpload, reason: "Upload manifest", taskIdentity, destructive: true }),
      workSessionId,
    };
    expect(await consumeLocalShellApproval(dir, manifest)).toBe(true);
    expect(await consumeLocalShellApproval(dir, manifest)).toBe(false);
    const verification = {
      ...input({ command: verify, reason: "Verify public endpoint", taskIdentity, destructive: false }),
      workSessionId,
    };
    expect(await consumeLocalShellApproval(dir, verification)).toBe(true);
    expect(await consumeLocalShellApproval(dir, verification)).toBe(false);
    expect(await consumeLocalShellApproval(dir, input({ command: "gh release delete android-channel --yes", taskIdentity, destructive: true }))).toBe(false);
    expect(await consumeLocalShellApproval(dir, input({ command: manifestUpload, taskIdentity: "goal:other-release", destructive: true }))).toBe(false);
    expect(await consumeLocalShellApproval(dir, input({ command: manifestUpload, taskIdentity, destructive: false }))).toBe(false);
  });

  it("reuses one pending release bundle for predeclared upload, deploy, and verify commands", async () => {
    const dir = await stateDir();
    const taskIdentity = "goal:cleantube-friends-release";
    const upload = "gh release upload friends-assets YouTube-Music.apk --clobber";
    const deploy = "npx wrangler deploy --config update-proxy/wrangler.jsonc";
    const verify = "curl -I https://updates.example.com/android/latest.apk";
    const musicVerify = "curl -I https://updates.example.com/music/youtube-music.apk";
    const first = await requestLocalShellApproval(dir, input({
      command: upload,
      reason: "Finish CleanTube friends release",
      taskIdentity,
      destructive: true,
      bundle: {
        label: "CleanTube friends release",
        entries: [
          { command: upload, needsNetwork: true, destructive: true },
          { command: deploy, needsNetwork: true, destructive: true },
          { command: verify, needsNetwork: true, destructive: false },
          { command: musicVerify, needsNetwork: true, destructive: false },
        ],
      },
    }));

    const reusedDeploy = await requestLocalShellApproval(dir, input({
      command: deploy,
      reason: "Deploy unified worker",
      taskIdentity,
      destructive: true,
    }));
    const reusedVerify = await requestLocalShellApproval(dir, input({
      command: verify,
      reason: "Verify public Android endpoint",
      taskIdentity,
      destructive: false,
    }));
    expect(reusedDeploy.id).toBe(first.id);
    expect(reusedVerify.id).toBe(first.id);
    expect(await listPendingLocalShellApprovals(dir)).toHaveLength(1);

    const otherGoal = await requestLocalShellApproval(dir, input({
      command: deploy,
      reason: "Deploy another release",
      taskIdentity: "goal:another-release",
      destructive: true,
    }));
    expect(otherGoal.id).not.toBe(first.id);

    const changedRisk = await requestLocalShellApproval(dir, input({
      command: verify,
      reason: "Verify with changed risk classification",
      taskIdentity,
      destructive: true,
    }));
    expect(changedRisk.id).not.toBe(first.id);
    expect(await listPendingLocalShellApprovals(dir)).toHaveLength(3);
  });

  it("upgrades an exact pending approval to a wider predeclared bundle without creating a second approval", async () => {
    const dir = await stateDir();
    const workSessionId = "ws_pending_upgrade";
    const taskIdentity = `goal:pending-upgrade:work-session:${workSessionId}`;
    const firstCommand = "npm run release:publish";
    const deployCommand = "npm run cf:update-proxy:deploy";
    const verifyCommand = "npm run verify:update-channel";

    const first = await requestLocalShellApproval(dir, input({
      command: firstCommand,
      taskIdentity,
      workSessionId,
      destructive: true,
    }));
    expect(first.bundleCommandKeys).toBeUndefined();

    const upgraded = await requestLocalShellApproval(dir, input({
      command: firstCommand,
      taskIdentity,
      workSessionId,
      destructive: true,
      bundle: {
        label: "Release and verify",
        entries: [
          { command: firstCommand, needsNetwork: true, destructive: true },
          { command: deployCommand, needsNetwork: true, destructive: true },
          { command: verifyCommand, needsNetwork: true, destructive: false },
        ],
      },
    }));

    expect(upgraded.id).toBe(first.id);
    expect(upgraded.bundleLabel).toBe("Release and verify");
    expect(upgraded.bundleCommandKeys).toHaveLength(3);
    expect(await listPendingLocalShellApprovals(dir)).toHaveLength(1);

    await resolveLocalShellApproval(dir, upgraded.id, "approve");
    expect(await consumeLocalShellApproval(dir, input({
      command: firstCommand,
      taskIdentity,
      workSessionId,
      destructive: true,
    }))).toBe(true);
    expect(await consumeLocalShellApproval(dir, input({
      command: deployCommand,
      taskIdentity,
      workSessionId,
      destructive: true,
    }))).toBe(true);
    expect(await consumeLocalShellApproval(dir, input({
      command: verifyCommand,
      taskIdentity,
      workSessionId,
      destructive: false,
    }))).toBe(true);
  });

  it("never widens a bundle after the owner has already approved it", async () => {
    const dir = await stateDir();
    const taskIdentity = "goal:no-post-approval-widen";
    const command = "npm run release:publish";
    const approved = await requestLocalShellApproval(dir, input({ command, taskIdentity, destructive: true }));
    await resolveLocalShellApproval(dir, approved.id, "approve");

    const repeated = await requestLocalShellApproval(dir, input({
      command,
      taskIdentity,
      destructive: true,
      bundle: {
        label: "Too late",
        entries: [
          { command, needsNetwork: true, destructive: true },
          { command: "npm run cf:update-proxy:deploy", needsNetwork: true, destructive: true },
        ],
      },
    }));

    expect(repeated.status).toBe("approved");
    expect(repeated.bundleCommandKeys).toBeUndefined();
  });

  it("keeps identical exact commands isolated between task identities", async () => {
    const dir = await stateDir();
    const command = "curl -I https://updates.example.com";
    const first = await requestLocalShellApproval(dir, input({ command, taskIdentity: "goal:first" }));
    const second = await requestLocalShellApproval(dir, input({ command, taskIdentity: "goal:second" }));
    expect(second.id).not.toBe(first.id);
    expect(await listPendingLocalShellApprovals(dir)).toHaveLength(2);
  });

  it("does not persist a task bundle without a stable task identity or reason", async () => {
    const dir = await stateDir();
    const bundled = input({
      command: "gh release upload android-channel app.apk",
      reason: undefined,
      taskIdentity: undefined,
      destructive: true,
      bundle: {
        label: "Unscoped bundle",
        entries: [
          { command: "gh release upload android-channel app.apk", needsNetwork: true, destructive: true },
          { command: "gh release upload android-channel manifest.json", needsNetwork: true, destructive: true },
        ],
      },
    });
    const requested = await requestLocalShellApproval(dir, bundled);
    expect(requested.bundleLabel).toBeUndefined();
    await resolveLocalShellApproval(dir, requested.id, "approve");
    expect(await consumeLocalShellApproval(dir, bundled)).toBe(true);
    expect(await consumeLocalShellApproval(dir, input({
      command: "gh release upload android-channel manifest.json",
      reason: undefined,
      taskIdentity: undefined,
      destructive: true,
    }))).toBe(false);
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
      command: "npx wrangler pages deploy dist --project-name jingyeong-vibe",
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

// MCP tool registrations (e2e). Extracted from src/server/tools.ts; behavior unchanged.
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../../types.js";
import { inspectShellCommand, runLocalShell } from "../../exec/local-shell.js";
import { captureE2eAppScreenshotSet, captureE2eScreenshot, captureE2eUrlScreenshot, captureE2eUrlScreenshotSet, openE2eTarget, startE2eServer, stopE2eServer } from "../../e2e/local-e2e.js";
import { resolveInProject } from "../../policy/paths.js";
import { redact } from "../../policy/secrets.js";
import { dispatchExecutorJob } from "../../executors/broker.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { WorkSessionIdSchema, hasTaskNetworkVerificationApproval, recordVerification, requireProjectLease, resolveOrThrow, localExecutionRoot, isRemoteProject, remotePayload, LOCAL_STATE_ANNOTATIONS, COMMAND_RUN_ANNOTATIONS, E2E_ONE_SHOT_ANNOTATIONS, chatGptToolMeta, withErrorMapping, E2E_WIDGET_TOOL_META, attachE2eInlineShare, attachE2eInlineShareSet, type RemoteE2eScreenshotResult, materializeRemoteE2eScreenshot, withE2eImageContent, resolveProjectForE2e, isLocalHttpUrl, discoverE2eAutomation } from "./shared.js";
import type { RegisterTool } from "./register.js";

export function registerE2eTools(registerTool: RegisterTool, ctx: ToolContext): void {

  registerTool(
    "e2e_start_server",
    {
      title: "Start E2E dev server",
      description:
        "Start a long-running local dev/server command in the selected project, optionally wait for a localhost URL, and return pid/log path. Use before E2E browser/app screenshots.",
      annotations: COMMAND_RUN_ANNOTATIONS,
      _meta: chatGptToolMeta("Starting E2E server...", "E2E server started"),
      inputSchema: {
        projectId: z.string(),
        workSessionId: WorkSessionIdSchema.optional(),
        command: z.string(),
        cwd: z.string().optional(),
        label: z.string().optional(),
        instanceKey: z.string().min(1).max(80).optional(),
        waitUrl: z.string().optional(),
        waitTimeoutSec: z.number().int().min(1).max(120).optional(),
        intent: z
          .object({
            writesWorkspace: z.boolean().optional(),
            needsNetwork: z.boolean().optional(),
            destructive: z.boolean().optional(),
          })
          .optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "e2e_start_server", { ...input, command: redact(input.command) }, async () => {
        await requireProjectLease(ctx, input.projectId, input.intent?.writesWorkspace ? "write" : "verify");
        const detectedRisk = inspectShellCommand(input.command);
        const destructive = Boolean(input.intent?.destructive || detectedRisk.destructive);
        const needsNetwork = Boolean(input.intent?.needsNetwork || detectedRisk.needsNetwork);
        const externalWaitUrl = Boolean(input.waitUrl && /^https?:\/\//i.test(input.waitUrl) && !isLocalHttpUrl(input.waitUrl));
        const taskNetworkApproved = (needsNetwork || externalWaitUrl)
          ? await hasTaskNetworkVerificationApproval(ctx, input.projectId, input.workSessionId, input.cwd)
          : false;
        if (destructive) {
          throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "Destructive E2E server requests still require an exact local-shell approval path");
        }
        if ((needsNetwork || externalWaitUrl) && !taskNetworkApproved) {
          throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "This E2E network verification requires an active task approval");
        }
        if (input.waitUrl && !isLocalHttpUrl(input.waitUrl) && !taskNetworkApproved) {
          throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "Waiting on a non-local URL requires an active task approval");
        }
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const result = await startE2eServer(await localExecutionRoot(ctx, entry), {
          command: input.command,
          cwd: input.cwd,
          label: input.label,
          reuseKey: `${input.projectId}:${input.workSessionId ?? "default"}:${input.instanceKey ?? "primary"}`,
          waitUrl: input.waitUrl,
          waitTimeoutSec: input.waitTimeoutSec,
        });
        await ctx.ledger.append({
          type: "e2e.server.started",
          projectId: input.projectId,
          runId: result.runId,
          pid: result.pid,
          command: redact(input.command),
        });
        return makeResult(
          {
            ...result,
            logPath: result.logPath,
          },
          result.reused
            ? `Reused E2E server ${result.runId} as pid ${result.pid}${result.wait ? `; wait ok=${result.wait.ok}` : ""}.`
            : `E2E server ${result.runId} started as pid ${result.pid}${result.replacedPid ? `; replaced pid ${result.replacedPid}` : ""}${result.wait ? `; wait ok=${result.wait.ok}` : ""}.`,
        );
      });
    },
  );

  registerTool(
    "e2e_open_target",
    {
      title: "Open E2E target",
      description: "Open a URL, installed macOS app name, or allowed local .app path for E2E verification.",
      annotations: COMMAND_RUN_ANNOTATIONS,
      _meta: chatGptToolMeta("Opening E2E target...", "E2E target opened"),
      inputSchema: {
        projectId: z.string().optional(),
        workSessionId: WorkSessionIdSchema.optional(),
        url: z.string().optional(),
        appName: z.string().optional(),
        appPath: z.string().optional(),
        args: z.array(z.string()).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "e2e_open_target", input, async () => {
        let appPath = input.appPath;
        if (input.url !== undefined) {
          if (!input.projectId) {
            throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "projectId is required to open a URL target");
          }
          if (!isLocalHttpUrl(input.url)) {
            const approvedExternalHttp = /^https?:\/\//i.test(input.url)
              ? await hasTaskNetworkVerificationApproval(ctx, input.projectId, input.workSessionId)
              : false;
            if (!approvedExternalHttp) {
              throw new DomainError(
                ErrorCode.APPROVAL_REQUIRED,
                "e2e_open_target only opens local URLs unless the active task has an approved external-http verification grant.",
              );
            }
          }
        }
        if (input.projectId) {
          await requireProjectLease(ctx, input.projectId, "verify");
          const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
          await localExecutionRoot(ctx, entry);
          if (appPath && !path.isAbsolute(appPath)) {
            appPath = await resolveInProject(entry.root, appPath, { allowSymlink: false });
          } else if (appPath && path.isAbsolute(appPath) && !appPath.startsWith("/Applications/")) {
            const root = await fs.realpath(entry.root);
            const checkedAppPath = appPath;
            const realApp = await fs.realpath(checkedAppPath).catch(() => checkedAppPath);
            if (!realApp.startsWith(`${root}${path.sep}`)) {
              throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "appPath must be under /Applications or inside the selected project");
            }
          }
        } else if (appPath && !appPath.startsWith("/Applications/")) {
          throw new DomainError(ErrorCode.PROJECT_NOT_SELECTED, "projectId is required for project-relative appPath");
        }
        const approvedExternalHttp = Boolean(input.url && !isLocalHttpUrl(input.url) && /^https?:\/\//i.test(input.url) && input.projectId
          ? await hasTaskNetworkVerificationApproval(ctx, input.projectId, input.workSessionId)
          : false);
        const result = await openE2eTarget({ url: input.url, appName: input.appName, appPath, args: input.args, approvedExternalHttp });
        await ctx.ledger.append({ type: "e2e.target.opened", projectId: input.projectId, launched: result.launched });
        return makeResult(result, `Opened E2E target: ${result.launched}`);
      });
    },
  );

  registerTool(
    "e2e_run_command",
    {
      title: "Run E2E command",
      description:
        "Run a guarded project E2E/test command and capture a macOS screenshot by default. Use after e2e_start_server when a dev server is needed.",
      annotations: COMMAND_RUN_ANNOTATIONS,
      _meta: chatGptToolMeta("Running E2E command...", "E2E command finished", E2E_WIDGET_TOOL_META),
      inputSchema: {
        projectId: z.string(),
        workSessionId: WorkSessionIdSchema.optional(),
        command: z.string(),
        cwd: z.string().optional(),
        timeoutSec: z.number().int().min(1).max(900).optional(),
        label: z.string().optional(),
        captureScreenshot: z.boolean().optional(),
        screenshotUrl: z.string().optional(),
        screenshotWaitMs: z.number().int().min(0).max(30_000).optional(),
        openAfterCapture: z.boolean().optional(),
        intent: z
          .object({
            writesWorkspace: z.boolean().optional(),
            needsNetwork: z.boolean().optional(),
            destructive: z.boolean().optional(),
          })
          .optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "e2e_run_command", { ...input, command: redact(input.command) }, async () => {
        await requireProjectLease(ctx, input.projectId, input.intent?.writesWorkspace ? "write" : "verify");
        const detectedRisk = inspectShellCommand(input.command);
        const destructive = Boolean(input.intent?.destructive || detectedRisk.destructive);
        const needsNetwork = Boolean(input.intent?.needsNetwork || detectedRisk.needsNetwork);
        const externalScreenshotHttp = Boolean(input.screenshotUrl && /^https?:\/\//i.test(input.screenshotUrl) && !isLocalHttpUrl(input.screenshotUrl));
        const taskNetworkApproved = (needsNetwork || externalScreenshotHttp)
          ? await hasTaskNetworkVerificationApproval(ctx, input.projectId, input.workSessionId, input.cwd)
          : false;
        if (destructive) {
          throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "Destructive E2E commands still require an exact local-shell approval path");
        }
        if (needsNetwork && !taskNetworkApproved) {
          throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "This E2E network command requires an active task approval");
        }
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        await ctx.ledger.append({
          type: "e2e.command.started",
          projectId: input.projectId,
          command: redact(input.command),
        });
        const result = await runLocalShell(
          await localExecutionRoot(ctx, entry),
          input.command,
          input.cwd,
          input.timeoutSec,
          taskNetworkApproved ? { needsNetwork: true } : undefined,
        );
        let screenshot:
          | {
              path: string;
              bytes: number;
              opened: boolean;
              markdown: string;
            }
          | undefined;
        if (input.captureScreenshot !== false) {
          let captured: Awaited<ReturnType<typeof captureE2eScreenshot>>;
          if (input.screenshotUrl) {
            captured = await captureE2eUrlScreenshot(await localExecutionRoot(ctx, entry), {
              url: input.screenshotUrl,
              label: input.label ?? "e2e-command",
              waitMs: input.screenshotWaitMs ?? 1800,
              openAfterCapture: input.openAfterCapture,
              approvedExternalHttp: taskNetworkApproved,
            });
          } else {
            captured = await captureE2eScreenshot(await localExecutionRoot(ctx, entry), {
              label: input.label ?? "e2e-command",
              waitMs: input.screenshotWaitMs,
              openAfterCapture: input.openAfterCapture,
            });
          }
          screenshot = await attachE2eInlineShare(ctx, captured, "E2E screenshot");
        }
        await ctx.ledger.append({
          type: "e2e.command.finished",
          projectId: input.projectId,
          command: redact(input.command),
          exitCode: result.exitCode,
          screenshotPath: screenshot?.path,
        });
        await recordVerification(ctx, input.projectId, input.workSessionId, {
          tool: "e2e_run_command",
          command: redact(input.command).slice(0, 500),
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });
        return withE2eImageContent(
          makeResult(
            {
              cwd: result.cwd,
              exitCode: result.exitCode,
              stdoutSummary: result.stdoutSummary,
              stderrSummary: result.stderrSummary,
              durationMs: result.durationMs,
              outputTruncated: result.outputTruncated,
              screenshot,
            },
            `E2E command exited ${result.exitCode} in ${result.durationMs}ms${screenshot ? `; screenshot ready.\n${screenshot.markdown}` : ""}.`,
          ),
          screenshot ? [screenshot] : [],
        );
      });
    },
  );

  registerTool(
    "e2e_test_and_show_screenshot",
    {
      title: "E2E test and show screenshot",
      description:
        "One-shot local E2E proof tool. Call immediately when the user says 'e2e 테스트하고 스크린샷 보여줘' or 'run e2e and show me the screenshot'. Uses the active project by default, detects web vs desktop-app projects such as Tauri, runs only discovered local package scripts, opens the built desktop app for Tauri projects, and captures visual proof. macOS supports app-window and top/middle/bottom browser-region screenshots; Windows web projects use an installed Edge/Chrome with an isolated profile and capture desktop plus 390x844 mobile top/middle/bottom views. Screenshots render inline in ChatGPT through the E2E screenshot widget and return inline image markdown through GPT Actions. If the discovered local check fails, the assistant must inspect logs, make normal code fixes with separate coding tools, rerun E2E, and only then show the final passing screenshot set.",
      annotations: E2E_ONE_SHOT_ANNOTATIONS,
      _meta: chatGptToolMeta("Running E2E and capturing screenshot...", "E2E screenshot ready", E2E_WIDGET_TOOL_META),
      inputSchema: {
        projectId: z.string().optional(),
        workSessionId: WorkSessionIdSchema.optional(),
        instruction: z.string().optional(),
        url: z.string().optional(),
        cwd: z.string().optional(),
        timeoutSec: z.number().int().min(1).max(900).optional(),
        screenshotWaitMs: z.number().int().min(0).max(30_000).optional(),
        openAfterCapture: z.boolean().optional(),
      },
    },
    async (input) => {
      return withErrorMapping(
        ctx,
        "e2e_test_and_show_screenshot",
        {
          ...input,
          instruction: input.instruction ? "[instruction redacted]" : undefined,
        },
        async () => {
          const project = await resolveProjectForE2e(ctx, input.projectId);
          let server:
            | {
                runId: string;
                pid: number;
                cwd: string;
                logPath: string;
                wait?: { ok: boolean; status?: number; error?: string; elapsedMs: number };
              }
            | undefined;
          const autoDiscovered = await discoverE2eAutomation(project.root, input.cwd);
          const discovered = autoDiscovered;
          const autoServerCommand = discovered.devCommand;
          const autoWaitUrl = discovered.devUrl;
          let serverStopped: { stopped: boolean; error?: string } | undefined;
          let stopAttempted = false;
          const stopAutoServer = async (): Promise<void> => {
            if (!server || stopAttempted) {
              return;
            }
            stopAttempted = true;
            serverStopped = await stopE2eServer(server);
          };
          try {
            const externalRequestedUrl = Boolean(input.url && /^https?:\/\//i.test(input.url) && !isLocalHttpUrl(input.url));
            const externalAutoWaitUrl = Boolean(autoWaitUrl && /^https?:\/\//i.test(autoWaitUrl) && !isLocalHttpUrl(autoWaitUrl));
            const taskNetworkApproved = (externalRequestedUrl || externalAutoWaitUrl)
              ? await hasTaskNetworkVerificationApproval(ctx, project.projectId, input.workSessionId, input.cwd)
              : false;
            if (input.url && !isLocalHttpUrl(input.url) && !taskNetworkApproved) {
              throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "One-shot E2E external HTTP screenshots require an active task approval; file/custom-scheme URLs remain blocked.");
            }
            if (autoServerCommand) {
              if (autoWaitUrl && !isLocalHttpUrl(autoWaitUrl) && !taskNetworkApproved) {
                throw new DomainError(ErrorCode.APPROVAL_REQUIRED, "Waiting on a non-local URL requires an active task approval");
              }
              server = await startE2eServer(project.root, {
                command: autoServerCommand,
                cwd: input.cwd,
                label: "one-shot-e2e",
                waitUrl: autoWaitUrl,
                waitTimeoutSec: 45,
              });
            }

            const command = discovered.command;
            const commandResult = command ? await runLocalShell(project.root, command, input.cwd, input.timeoutSec) : undefined;
            const screenshotUrl = input.url ?? autoWaitUrl;
            const screenshots =
              discovered.targetKind === "desktop-app" && discovered.targetAppName && !input.url
                ? await (async () => {
                    if (discovered.targetAppPath) {
                      await openE2eTarget({ appPath: discovered.targetAppPath });
                    }
                    return captureE2eAppScreenshotSet(project.root, {
                      appName: discovered.targetAppName!,
                      label: "e2e-test",
                      waitMs: input.screenshotWaitMs ?? 1800,
                      openAfterCapture: input.openAfterCapture,
                    });
                  })()
                : screenshotUrl
                  ? await captureE2eUrlScreenshotSet(project.root, {
                      url: screenshotUrl,
                      label: "e2e-test",
                      waitMs: input.screenshotWaitMs ?? 1800,
                      openAfterCapture: input.openAfterCapture,
                      approvedExternalHttp: taskNetworkApproved,
                    })
                  : [
                      await captureE2eScreenshot(project.root, {
                        label: "e2e-test",
                        waitMs: input.screenshotWaitMs ?? 500,
                        openAfterCapture: input.openAfterCapture,
                      }),
                    ];
            await stopAutoServer();
            const captured = screenshots[0]!;
            const screenshotSet = await attachE2eInlineShareSet(ctx, screenshots);
            const screenshot = screenshotSet[0] ?? (await attachE2eInlineShare(ctx, captured, "E2E screenshot"));
            const needsRepair = Boolean(commandResult && commandResult.exitCode !== 0) || Boolean(server?.wait && !server.wait.ok);
            await recordVerification(ctx, project.projectId, input.workSessionId, {
              tool: "e2e_test_and_show_screenshot",
              command: command ? redact(command).slice(0, 500) : "visual-smoke",
              success: !needsRepair,
              exitCode: commandResult?.exitCode ?? null,
              durationMs: commandResult?.durationMs ?? null,
            });
            await ctx.ledger.append({
              type: "e2e.one_shot.finished",
              projectId: project.projectId,
              command: command ? redact(command) : undefined,
              commandSource: discovered.commandSource,
              serverCommand: autoServerCommand ? redact(autoServerCommand) : undefined,
              serverSource: discovered.devSource,
              exitCode: commandResult?.exitCode,
              screenshotPath: captured.path,
              screenshotCount: screenshotSet.length,
            });
            return withE2eImageContent(
              makeResult(
                {
                  projectId: project.projectId,
                  instruction: input.instruction ? redact(input.instruction).slice(0, 500) : undefined,
                  server,
                  command,
                  commandSource: discovered.commandSource,
                  commandSkippedReason: command
                    ? undefined
                    : "No E2E/test/build command was provided or discovered. App/dev-server smoke screenshot captured only when possible.",
                  commandResult,
                  needsRepair,
                  repairInstruction: needsRepair
                    ? "Inspect logs and command output, fix the project with coding tools, rerun E2E, then return only the passing screenshot set."
                    : undefined,
                  devServerCommand: autoServerCommand,
                  devServerSource: discovered.devSource,
                  devServerStopped: serverStopped,
                  targetKind: discovered.targetKind,
                  targetAppName: discovered.targetAppName,
                  targetAppPath: discovered.targetAppPath,
                  screenshotUrl,
                  screenshot,
                  screenshotSet,
                },
                needsRepair
                  ? `${discovered.targetKind} E2E failed and needs repair before final response; captured diagnostic screenshots.\n${screenshotSet.map((shot) => shot.markdown).join("\n")}`
                  : command
                    ? `${discovered.targetKind} E2E command (${discovered.commandSource}) exited ${commandResult?.exitCode ?? "unknown"}; ${screenshotSet.length} screenshots ready.\n${screenshotSet.map((shot) => shot.markdown).join("\n")}`
                    : `${discovered.targetKind} smoke E2E completed; ${screenshotSet.length} screenshots ready.\n${screenshotSet.map((shot) => shot.markdown).join("\n")}`,
              ),
              screenshotSet,
            );
          } finally {
            await stopAutoServer();
          }
        },
      );
    },
  );

  registerTool(
    "e2e_screenshot",
    {
      title: "Capture E2E screenshot",
      description:
        "Capture the current macOS or Windows screen to .jk/e2e/screenshots in the selected project. Remote Windows projects capture on their executor and return visual proof to the hub.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Capturing E2E screenshot...", "E2E screenshot captured", E2E_WIDGET_TOOL_META),
      inputSchema: {
        projectId: z.string(),
        label: z.string().optional(),
        waitMs: z.number().int().min(0).max(30_000).optional(),
        openAfterCapture: z.boolean().optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "e2e_screenshot", input, async () => {
        await requireProjectLease(ctx, input.projectId, "verify");
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const result = isRemoteProject(entry)
          ? await materializeRemoteE2eScreenshot(
              ctx,
              await dispatchExecutorJob<RemoteE2eScreenshotResult>(
                ctx.stateDir,
                entry.executorId,
                "e2e_screenshot",
                remotePayload(entry, {
                  label: input.label,
                  waitMs: input.waitMs,
                  openAfterCapture: input.openAfterCapture,
                }),
              ),
            )
          : await captureE2eScreenshot(await localExecutionRoot(ctx, entry), {
              label: input.label,
              waitMs: input.waitMs,
              openAfterCapture: input.openAfterCapture,
            });
        await ctx.ledger.append({
          type: "e2e.screenshot.captured",
          projectId: input.projectId,
          path: "remotePath" in result ? result.remotePath : result.path,
        });
        const screenshot = await attachE2eInlineShare(ctx, result, "E2E screenshot");
        return withE2eImageContent(makeResult({ ...screenshot }, `Captured E2E screenshot.\n${screenshot.markdown}`), [screenshot]);
      });
    },
  );

  registerTool(
    "e2e_open_url_screenshot",
    {
      title: "Open URL and capture E2E screenshot",
      description: "Open a local loopback URL, wait briefly, and capture browser E2E proof. macOS captures the visible Chrome region; Windows uses an installed Edge/Chrome headless viewport.",
      annotations: COMMAND_RUN_ANNOTATIONS,
      _meta: chatGptToolMeta("Opening URL and capturing screenshot...", "E2E screenshot captured", E2E_WIDGET_TOOL_META),
      inputSchema: {
        projectId: z.string(),
        workSessionId: WorkSessionIdSchema.optional(),
        url: z.string(),
        label: z.string().optional(),
        waitMs: z.number().int().min(0).max(30_000).optional(),
        openAfterCapture: z.boolean().optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "e2e_open_url_screenshot", input, async () => {
        const approvedExternalHttp = !isLocalHttpUrl(input.url) && /^https?:\/\//i.test(input.url)
          ? await hasTaskNetworkVerificationApproval(ctx, input.projectId, input.workSessionId)
          : false;
        if (!isLocalHttpUrl(input.url) && !approvedExternalHttp) {
          throw new DomainError(
            ErrorCode.APPROVAL_REQUIRED,
            "URL screenshots only open local loopback URLs unless the active task has an approved external-http verification grant.",
          );
        }
        await requireProjectLease(ctx, input.projectId, "verify");
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const result = await captureE2eUrlScreenshot(await localExecutionRoot(ctx, entry), {
          url: input.url,
          label: input.label ?? "url",
          waitMs: input.waitMs ?? 1800,
          openAfterCapture: input.openAfterCapture,
          approvedExternalHttp,
        });
        await ctx.ledger.append({
          type: "e2e.url.screenshot.captured",
          projectId: input.projectId,
          url: input.url,
          path: result.path,
        });
        const screenshot = await attachE2eInlineShare(ctx, result, "E2E screenshot");
        return withE2eImageContent(
          makeResult(
            {
              url: input.url,
              ...screenshot,
            },
            `Opened ${input.url} and captured E2E screenshot.\n${screenshot.markdown}`,
          ),
          [screenshot],
        );
      });
    },
  );
}

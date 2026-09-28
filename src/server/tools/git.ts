// MCP tool registrations (git). Extracted from src/server/tools.ts; behavior unchanged.
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type ToolContext } from "../../types.js";
import { getWorkingDiff } from "../../state/checkpoints.js";
import { runLocalShell } from "../../exec/local-shell.js";
import { gitRepositoryStatus, gitStatus, gitDiffSummary, gitStageAndCommit, gitPush, gitSyncStart, gitSyncFinish } from "../../git/git.js";
import { resolveInProject } from "../../policy/paths.js";
import { redact } from "../../policy/secrets.js";
import { dispatchExecutorJob } from "../../executors/broker.js";
import { requireProjectLease, resolveOrThrow, localExecutionRoot, isRemoteProject, remotePayload, resolveRemotePathLexically, remoteNodeCommand, parseRemoteJsonOutput, READ_ONLY_ANNOTATIONS, LOCAL_WRITE_ANNOTATIONS, COMMAND_RUN_ANNOTATIONS, chatGptToolMeta, withErrorMapping, guardSecretPath } from "./shared.js";
import type { RegisterTool } from "./register.js";

export function registerGitTools(registerTool: RegisterTool, ctx: ToolContext): void {
  // -------------------------------------------------------------------
  // 8.6 Git tools
  // -------------------------------------------------------------------

  registerTool(
    "repo_status",
    {
      title: "Inspect repository status",
      description:
        "Read-only local repository status and configured remote/upstream relation. Uses git argv calls only; never fetches, pushes, commits, or writes.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Inspecting repository status...", "Repository status loaded"),
      inputSchema: { projectId: z.string() },
    },
    async (input) => {
      return withErrorMapping(ctx, "repo_status", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const status = isRemoteProject(entry)
          ? await dispatchExecutorJob<Awaited<ReturnType<typeof gitRepositoryStatus>>>(
              ctx.stateDir,
              entry.executorId,
              "repo_status",
              remotePayload(entry, {}),
            )
          : await gitRepositoryStatus(entry.root);
        return makeResult(
          { ...status },
          `Repository ${status.branch || "n/a"}: ${status.dirtyFiles.length} dirty, ${status.staged.length} staged, upstream=${status.upstream ?? "none"}, ${status.syncState}.`,
        );
      });
    },
  );

  registerTool(
    "git_sync_start",
    {
      title: "Sync remote-worker checkout",
      description:
        "Prepare a cloud/remote-worker checkout before coding. Requires a clean tree and configured upstream, fetches the upstream remote, and fast-forwards only. It refuses local-only commits, dirty work, or divergence; it never stashes, resets, rebases, or force-updates.",
      annotations: COMMAND_RUN_ANNOTATIONS,
      _meta: chatGptToolMeta("Syncing remote-worker checkout...", "Remote-worker checkout synced"),
      inputSchema: { projectId: z.string() },
    },
    async (input) => {
      return withErrorMapping(ctx, "git_sync_start", input, async () => {
        await requireProjectLease(ctx, input.projectId, "remote");
        await requireProjectLease(ctx, input.projectId, "write");
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const result = isRemoteProject(entry)
          ? await dispatchExecutorJob<Awaited<ReturnType<typeof gitSyncStart>>>(
              ctx.stateDir,
              entry.executorId,
              "git_sync_start",
              remotePayload(entry, {}),
              150_000,
            )
          : await gitSyncStart(await localExecutionRoot(ctx, entry));
        await ctx.ledger.append({
          type: "git.sync.started",
          projectId: input.projectId,
          branch: result.branch,
          upstream: result.upstream,
          fastForwarded: result.fastForwarded,
        });
        return makeResult(
          {
            branch: result.branch,
            upstream: result.upstream,
            remote: result.remote,
            fastForwarded: result.fastForwarded,
            before: result.before,
            after: result.after,
            sourceOfTruth: "GitHub",
            windowsAutoPull: false,
            finishPolicy: "verify -> inspect diff -> git_sync_finish; Windows updates only on explicit pull",
          },
          `Remote-worker checkout ${result.branch} is clean and aligned with ${result.upstream}${result.fastForwarded ? " after fast-forward" : ""}.`,
        );
      });
    },
  );

  registerTool(
    "repo_diff_summary",
    {
      title: "Summarize repository diff",
      description: "Read-only local working diff summary with secret redaction. Never stages, commits, pushes, or contacts remotes.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Summarizing repository diff...", "Repository diff summarized"),
      inputSchema: { projectId: z.string() },
    },
    async (input) => {
      return withErrorMapping(ctx, "repo_diff_summary", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const result = isRemoteProject(entry)
          ? await dispatchExecutorJob<Awaited<ReturnType<typeof gitDiffSummary>>>(
              ctx.stateDir,
              entry.executorId,
              "repo_diff_summary",
              remotePayload(entry, {}),
            )
          : await gitDiffSummary(entry.root);
        return makeResult(
          {
            files: result.files.map((f) => ({ path: f.path, "+": f.added, "-": f.removed })),
            summary: result.summary,
          },
          result.summary,
        );
      });
    },
  );

  registerTool(
    "git_status",
    {
      title: "Inspect repository status (legacy)",
      description: "Legacy read-only alias. Prefer repo_status because it also returns configured remote/upstream state.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Checking git status...", "Git status loaded"),
      inputSchema: { projectId: z.string() },
    },
    async (input) => {
      return withErrorMapping(ctx, "git_status", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const status = await gitStatus(entry.root);
        return makeResult(
          { branch: status.branch, dirtyFiles: status.dirtyFiles, staged: status.staged, ahead: 0, behind: 0 },
          `Branch ${status.branch || "n/a"}: ${status.dirtyFiles.length} dirty, ${status.staged.length} staged.`,
        );
      });
    },
  );

  registerTool(
    "git_diff_summary",
    {
      title: "Summarize git diff",
      description: "Summarize the working diff for a project, with secret redaction applied.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Summarizing git diff...", "Git diff summarized"),
      inputSchema: { projectId: z.string() },
    },
    async (input) => {
      return withErrorMapping(ctx, "git_diff_summary", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const result = await gitDiffSummary(entry.root);
        return makeResult(
          {
            files: result.files.map((f) => ({ path: f.path, "+": f.added, "-": f.removed })),
            summary: result.summary,
          },
          result.summary,
        );
      });
    },
  );

  registerTool(
    "git_commit",
    {
      title: "Commit project changes",
      description:
        "Stage and commit project changes with a message. Use only after inspecting git_status/git_diff_summary and only when the user explicitly asks to commit.",
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: chatGptToolMeta("Committing project changes...", "Project changes committed"),
      inputSchema: {
        projectId: z.string(),
        message: z.string(),
        paths: z.array(z.string()).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "git_commit", input, async () => {
        await requireProjectLease(ctx, input.projectId, "write");
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        if (isRemoteProject(entry)) {
          if (!input.paths || input.paths.length === 0) {
            throw new DomainError(
              ErrorCode.COMMAND_NOT_ALLOWED,
              "Remote git_commit requires explicit paths so JK can verify the exact commit boundary",
            );
          }
          for (const rel of input.paths) {
            await guardSecretPath(ctx, resolveRemotePathLexically(entry.root, rel), "git_commit");
          }

          const discoveryData = Buffer.from(JSON.stringify({ paths: input.paths }), "utf8").toString("base64");
          const discoveryCommand = remoteNodeCommand(`
const cp=require('node:child_process');
const data=JSON.parse(Buffer.from('${discoveryData}','base64').toString('utf8'));
function run(args){const r=cp.spawnSync('git',args,{encoding:'utf8'});if(r.status!==0){process.stderr.write(String(r.stderr||''));process.exit(r.status||1)}return String(r.stdout||'')}
function lines(value){return value.split(/\\r?\\n/).map(v=>v.trim()).filter(Boolean)}
const stagedAll=lines(run(['diff','--cached','--name-only']));
const modified=lines(run(['diff','--name-only','--',...data.paths]));
const stagedRequested=lines(run(['diff','--cached','--name-only','--',...data.paths]));
const untracked=lines(run(['ls-files','--others','--exclude-standard','--',...data.paths]));
const candidates=[...new Set([...modified,...stagedRequested,...untracked])].sort();
console.log(JSON.stringify({candidates,stagedAll}));
`);
          const discovery = await dispatchExecutorJob<Awaited<ReturnType<typeof runLocalShell>>>(
            ctx.stateDir,
            entry.executorId,
            "local_shell_run",
            remotePayload(entry, {
              command: discoveryCommand,
              cwd: ".",
              timeoutSec: 30,
              approvedNeedsNetwork: false,
              approvedDestructive: false,
            }),
            60_000,
          );
          if (discovery.exitCode !== 0) {
            throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Remote git commit discovery failed: ${redact(discovery.stderrSummary)}`);
          }
          const discovered = parseRemoteJsonOutput<{ candidates: string[]; stagedAll: string[] }>(
            discovery.stdoutSummary,
            "Remote git commit discovery",
          );
          for (const rel of discovered.candidates) {
            await guardSecretPath(ctx, resolveRemotePathLexically(entry.root, rel), "git_commit");
          }
          const allowed = new Set(discovered.candidates);
          const stagedOutsideBoundary = discovered.stagedAll.filter((rel) => !allowed.has(rel));
          if (stagedOutsideBoundary.length > 0) {
            throw new DomainError(
              ErrorCode.COMMAND_NOT_ALLOWED,
              "Refusing remote commit because files outside the requested paths are already staged",
              { stagedOutsideBoundary },
            );
          }
          if (discovered.candidates.length === 0) {
            throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "No changes within the requested paths to commit");
          }

          const commitData = Buffer.from(
            JSON.stringify({ message: input.message, candidates: discovered.candidates }),
            "utf8",
          ).toString("base64");
          const commitCommand = remoteNodeCommand(`
const cp=require('node:child_process');
const data=JSON.parse(Buffer.from('${commitData}','base64').toString('utf8'));
function run(args){const r=cp.spawnSync('git',args,{encoding:'utf8'});if(r.status!==0){process.stderr.write(String(r.stderr||''));process.exit(r.status||1)}return {stdout:String(r.stdout||''),stderr:String(r.stderr||'')}}
run(['add','--',...data.candidates]);
const staged=run(['diff','--cached','--name-only']).stdout.split(/\\r?\\n/).map(v=>v.trim()).filter(Boolean);
const allowed=new Set(data.candidates);
const extra=staged.filter(v=>!allowed.has(v));
if(extra.length){process.stderr.write('PRESTAGED_OUTSIDE_BOUNDARY:'+extra.join(','));process.exit(23)}
if(!staged.length){process.stderr.write('NO_STAGED_CHANGES');process.exit(24)}
const committed=run(['commit','-m',data.message]);
const commit=run(['rev-parse','--short','HEAD']).stdout.trim();
const branch=run(['rev-parse','--abbrev-ref','HEAD']).stdout.trim();
console.log(JSON.stringify({commit,branch,stagedFiles:staged,stdout:committed.stdout,stderr:committed.stderr}));
`);
          const remoteResult = await dispatchExecutorJob<Awaited<ReturnType<typeof runLocalShell>>>(
            ctx.stateDir,
            entry.executorId,
            "local_shell_run",
            remotePayload(entry, {
              command: commitCommand,
              cwd: ".",
              timeoutSec: 60,
              approvedNeedsNetwork: false,
              approvedDestructive: false,
            }),
            90_000,
          );
          if (remoteResult.exitCode !== 0) {
            throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Remote git commit failed: ${redact(remoteResult.stderrSummary)}`);
          }
          const result = parseRemoteJsonOutput<{
            commit: string;
            branch: string;
            stagedFiles: string[];
            stdout: string;
            stderr: string;
          }>(remoteResult.stdoutSummary, "Remote git commit");
          await ctx.ledger.append({
            type: "git.commit.completed",
            projectId: input.projectId,
            commit: result.commit,
            branch: result.branch,
            stagedFiles: result.stagedFiles,
          });
          return makeResult(
            {
              commit: result.commit,
              branch: result.branch,
              stagedFiles: result.stagedFiles,
              stdoutSummary: redact(result.stdout),
              stderrSummary: redact(result.stderr),
            },
            `Committed ${result.commit} on ${result.branch}.`,
          );
        }
        if (input.paths) {
          for (const rel of input.paths) {
            const abs = await resolveInProject(entry.root, rel, { allowSymlink: false });
            await guardSecretPath(ctx, abs, "git_commit");
          }
        }
        const result = await gitStageAndCommit(await localExecutionRoot(ctx, entry), input.message, input.paths);
        await ctx.ledger.append({
          type: "git.commit.completed",
          projectId: input.projectId,
          commit: result.commit,
          branch: result.branch,
          stagedFiles: result.stagedFiles,
        });
        return makeResult(
          {
            commit: result.commit,
            branch: result.branch,
            stagedFiles: result.stagedFiles,
            stdoutSummary: result.stdout,
            stderrSummary: result.stderr,
          },
          `Committed ${result.commit} on ${result.branch}.`,
        );
      });
    },
  );

  registerTool(
    "git_push",
    {
      title: "Push project branch",
      description:
        "Push the selected project's current branch to a git remote. Use only when the user explicitly asks to push.",
      annotations: COMMAND_RUN_ANNOTATIONS,
      _meta: chatGptToolMeta("Pushing project branch...", "Project branch pushed"),
      inputSchema: {
        projectId: z.string(),
        remote: z.string().optional(),
        branch: z.string().optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "git_push", input, async () => {
        await requireProjectLease(ctx, input.projectId, "remote");
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        if (isRemoteProject(entry)) {
          const status = await dispatchExecutorJob<Awaited<ReturnType<typeof gitRepositoryStatus>>>(
            ctx.stateDir,
            entry.executorId,
            "repo_status",
            remotePayload(entry, {}),
            60_000,
          );
          const currentBranch = status.branch;
          if (!currentBranch) {
            throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Cannot push a remote project without a current branch");
          }
          let targetRemote = input.remote ?? "origin";
          let targetBranch = input.branch ?? currentBranch;
          if (status.upstream) {
            const slash = status.upstream.indexOf("/");
            const upstreamRemote = slash > 0 ? status.upstream.slice(0, slash) : "";
            const upstreamBranch = slash > 0 ? status.upstream.slice(slash + 1) : "";
            if (!upstreamRemote || upstreamBranch !== currentBranch) {
              throw new DomainError(
                ErrorCode.COMMAND_NOT_ALLOWED,
                "Autonomous push requires the current branch to match its configured upstream",
                { branch: currentBranch, upstream: status.upstream },
              );
            }
            if ((input.remote && input.remote !== upstreamRemote) || (input.branch && input.branch !== currentBranch)) {
              throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Refusing to push outside the configured upstream", {
                branch: currentBranch,
                upstream: status.upstream,
              });
            }
            targetRemote = upstreamRemote;
            targetBranch = currentBranch;
          }
          const pushData = Buffer.from(JSON.stringify({ remote: targetRemote, branch: targetBranch }), "utf8").toString("base64");
          const pushCommand = remoteNodeCommand(`
const cp=require('node:child_process');
const data=JSON.parse(Buffer.from('${pushData}','base64').toString('utf8'));
const r=cp.spawnSync('git',['push','-u',data.remote,data.branch],{encoding:'utf8'});
if(r.status!==0){process.stderr.write(String(r.stderr||''));process.exit(r.status||1)}
console.log(JSON.stringify({stdout:String(r.stdout||''),stderr:String(r.stderr||'')}));
`);
          const remoteResult = await dispatchExecutorJob<Awaited<ReturnType<typeof runLocalShell>>>(
            ctx.stateDir,
            entry.executorId,
            "local_shell_run",
            remotePayload(entry, {
              command: pushCommand,
              cwd: ".",
              timeoutSec: 120,
              approvedNeedsNetwork: true,
              approvedDestructive: false,
            }),
            150_000,
          );
          if (remoteResult.exitCode !== 0) {
            throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Remote git push failed: ${redact(remoteResult.stderrSummary)}`);
          }
          const pushed = parseRemoteJsonOutput<{ stdout: string; stderr: string }>(remoteResult.stdoutSummary, "Remote git push");
          await ctx.ledger.append({
            type: "git.push.completed",
            projectId: input.projectId,
            remote: targetRemote,
            branch: targetBranch,
          });
          return makeResult(
            {
              remote: targetRemote,
              branch: targetBranch,
              stdoutSummary: redact(pushed.stdout),
              stderrSummary: redact(pushed.stderr),
            },
            `Pushed ${targetBranch} to ${targetRemote}.`,
          );
        }
        const result = await gitPush(await localExecutionRoot(ctx, entry), input.remote, input.branch);
        await ctx.ledger.append({
          type: "git.push.completed",
          projectId: input.projectId,
          remote: result.remote,
          branch: result.branch,
        });
        return makeResult(
          {
            remote: result.remote,
            branch: result.branch,
            stdoutSummary: result.stdout,
            stderrSummary: result.stderr,
          },
          `Pushed ${result.branch} to ${result.remote}.`,
        );
      });
    },
  );

  registerTool(
    "git_sync_finish",
    {
      title: "Commit and push remote-worker task",
      description:
        "Finish a verified cloud/remote-worker task by committing only the explicit task paths and pushing the current branch. Use after repo_diff_summary and verification when the user has established the remote-worker Git sync policy or explicitly asks to commit/push. Refuses pre-existing staged changes.",
      annotations: COMMAND_RUN_ANNOTATIONS,
      _meta: chatGptToolMeta("Publishing verified remote work...", "Verified remote work published"),
      inputSchema: {
        projectId: z.string(),
        message: z.string().min(1).max(500),
        paths: z.array(z.string().min(1)).min(1).max(100),
        remote: z.string().optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "git_sync_finish", input, async () => {
        await requireProjectLease(ctx, input.projectId, "write");
        await requireProjectLease(ctx, input.projectId, "remote");
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        for (const rel of input.paths) {
          const abs = await resolveInProject(entry.root, rel, { allowSymlink: false });
          await guardSecretPath(ctx, abs, "git_sync_finish");
        }
        const result = await gitSyncFinish(await localExecutionRoot(ctx, entry), input.message, input.paths, input.remote);
        await ctx.ledger.append({
          type: "git.sync.finished",
          projectId: input.projectId,
          commit: result.commit,
          branch: result.branch,
          remote: result.remote,
          stagedFiles: result.stagedFiles,
        });
        return makeResult(
          {
            ...result,
            sourceOfTruth: "GitHub",
            windowsAutoPull: false,
            localPcNextCommand: "manual pull only when explicitly requested",
          },
          `Published ${result.commit} to ${result.remote}/${result.branch}. Windows is not auto-updated; pull there only when explicitly requested.`,
        );
      });
    },
  );

  registerTool(
    "show_changes",
    {
      title: "Show project changes",
      description: "Return the current redacted working diff for review before commit or rollback.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Loading project changes...", "Project changes loaded"),
      inputSchema: { projectId: z.string() },
    },
    async (input) => {
      return withErrorMapping(ctx, "show_changes", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const diff = await getWorkingDiff(entry.root);
        return makeResult({ diff, bytes: Buffer.byteLength(diff, "utf8") }, diff ? "Working diff loaded." : "No working diff.");
      });
    },
  );
}

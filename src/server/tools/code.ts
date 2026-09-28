// MCP tool registrations (code). Extracted from src/server/tools.ts; behavior unchanged.
import { z } from "zod";
import { makeResult, type ToolContext } from "../../types.js";
import { nestedProjectRoots } from "../../workspace/registry.js";
import { codeSearch } from "../../code/search.js";
import { readSlice } from "../../code/read-slice.js";
import { ProjectMemoryStore, contextPackCacheKey, fingerprintFiles, fingerprintProject, resultCacheKey } from "../../state/project-memory.js";
import { resolveInProject } from "../../policy/paths.js";
import { isSecretPath, redact } from "../../policy/secrets.js";
import { dispatchExecutorJob } from "../../executors/broker.js";
import path from "node:path";
import { type WorkContextSlice, WorkSessionIdSchema, recordRecentWork, currentRegistry, resolveOrThrow, isRemoteProject, remotePayload, READ_ONLY_ANNOTATIONS, LOCAL_STATE_ANNOTATIONS, chatGptToolMeta, withErrorMapping, guardSecretPath } from "./shared.js";
import type { RegisterTool } from "./register.js";

export function registerCodeTools(registerTool: RegisterTool, ctx: ToolContext): void {
  // -------------------------------------------------------------------
  // 8.3 Code intelligence tools
  // -------------------------------------------------------------------

  registerTool(
    "code_search",
    {
      title: "Search project code",
      description: "Search project source code (ripgrep-backed, scoped to the project root).",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Searching project code...", "Project code search complete"),
      inputSchema: {
        projectId: z.string(),
        query: z.string(),
        mode: z.enum(["text", "symbol", "semantic"]).optional(),
        maxResults: z.number().int().positive().max(200).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "code_search", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const result = isRemoteProject(entry)
          ? await dispatchExecutorJob<Awaited<ReturnType<typeof codeSearch>>>(
              ctx.stateDir,
              entry.executorId,
              "code_search",
              remotePayload(entry, {
                query: input.query,
                mode: input.mode,
                maxResults: input.maxResults,
              }),
            )
          : await codeSearch(entry.root, input.query, input.mode, input.maxResults, nestedProjectRoots(await currentRegistry(ctx), entry));
        const filtered = [];
        for (const m of result.matches) {
          if (!isRemoteProject(entry)) {
            const abs = path.join(entry.root, m.path);
            if (isSecretPath(abs)) continue;
          }
          // isSecretPath only filters by path (denies .env/*.key/*token* etc
          // paths), it never inspects file content, so a hardcoded secret in
          // an ordinary file (src/config.ts, a log, ...) would otherwise be
          // returned verbatim. code_context_pack/file_read_slice already
          // redact() their content before returning it; match that here so
          // code_search can't be used as the unredacted side-channel for the
          // same secrets those tools mask.
          filtered.push({ ...m, snippet: redact(m.snippet) });
        }
        return makeResult(
          { matches: filtered, backend: result.backend },
          `Found ${filtered.length} match(es) via ${result.backend}.`,
        );
      });
    },
  );

  registerTool(
    "code_context_pack",
    {
      title: "Build code context pack",
      description:
        "Internal fallback: build a compact context bundle (search + slice reads) for a topic. ChatGPT should prefer code_search followed by narrow file_read_slice calls because broad context-pack requests may be blocked before reaching the local runtime.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Building code context...", "Code context ready"),
      inputSchema: {
        projectId: z.string(),
        topic: z.string(),
        files: z.array(z.string()).optional(),
        maxBytes: z.number().int().positive().max(100_000).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "code_context_pack", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const maxBytes = input.maxBytes ?? 20_000;
        const memory = new ProjectMemoryStore(ctx.stateDir);

        let candidateFiles = input.files;
        if (!candidateFiles || candidateFiles.length === 0) {
          const searchResult = await codeSearch(entry.root, input.topic, "text", 20, nestedProjectRoots(await currentRegistry(ctx), entry));
          const seen = new Set<string>();
          candidateFiles = [];
          for (const m of searchResult.matches) {
            if (!seen.has(m.path)) {
              seen.add(m.path);
              candidateFiles.push(m.path);
            }
            if (candidateFiles.length >= 8) break;
          }
        }

        const safeCandidateFiles = (candidateFiles ?? []).filter((rel) => !isSecretPath(path.join(entry.root, rel)));
        const fingerprint = await fingerprintFiles(entry.root, safeCandidateFiles);
        const cacheKey = contextPackCacheKey(input.topic, safeCandidateFiles, maxBytes);
        const cached = await memory.getContextPack(input.projectId, cacheKey, fingerprint);
        if (cached) {
          return makeResult(
            {
              bundle: cached.bundle,
              files: cached.files,
              truncated: cached.truncated,
              cacheHit: true,
              fingerprint,
            },
            `Context pack cache hit for "${input.topic}": ${cached.files.length} file(s), ${cached.bytesUsed} bytes.`,
          );
        }

        const files: { path: string; reason: string }[] = [];
        let bundle = "";
        let truncated = false;
        let bytesUsed = 0;

        for (const rel of safeCandidateFiles) {
          try {
            const slice = await readSlice(entry.root, rel, 1, 200);
            const chunk = `\n--- ${rel} ---\n${slice.content}\n`;
            const chunkBytes = Buffer.byteLength(chunk, "utf8");
            if (bytesUsed + chunkBytes > maxBytes) {
              truncated = true;
              break;
            }
            bundle += chunk;
            bytesUsed += chunkBytes;
            files.push({ path: rel, reason: `matched topic "${input.topic}"` });
          } catch {
            continue;
          }
        }

        const redactedBundle = redact(bundle);
        await memory.putContextPack(input.projectId, {
          key: cacheKey,
          fingerprint,
          topic: input.topic,
          bundle: redactedBundle,
          files,
          truncated,
          bytesUsed,
        });

        return makeResult(
          { bundle: redactedBundle, files, truncated, cacheHit: false, fingerprint },
          `Context pack for "${input.topic}": ${files.length} file(s), ${bytesUsed} bytes.`,
        );
      });
    },
  );

  registerTool(
    "analysis_cache_get",
    {
      title: "Read cached analysis",
      description:
        "Reuse a prior analysis/review result only when the task, role, and current project fingerprint still match. Pass files for a narrow file-scoped fingerprint; omit files for a git revision + dirty-state fingerprint.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Checking analysis cache...", "Analysis cache checked"),
      inputSchema: {
        projectId: z.string(),
        task: z.string().min(1).max(1000),
        role: z.string().max(200).optional(),
        files: z.array(z.string()).max(50).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "analysis_cache_get", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const snapshot = await fingerprintProject(entry.root, input.files);
        const key = resultCacheKey(input.task, input.role ?? null, snapshot.fingerprint);
        const memory = new ProjectMemoryStore(ctx.stateDir);
        const cached = await memory.getResult(input.projectId, key);
        return makeResult(
          {
            hit: Boolean(cached),
            value: cached?.value ?? null,
            fingerprint: snapshot.fingerprint,
            revision: snapshot.revision,
            dirty: snapshot.dirty,
            cacheKey: key,
          },
          cached ? "Reusable cached analysis found." : "No reusable cached analysis for the current project state.",
        );
      });
    },
  );

  registerTool(
    "analysis_cache_put",
    {
      title: "Store analysis result",
      description:
        "Store a compact review/debug/architecture result for reuse while the same task, role, and project fingerprint remain unchanged. This writes only JK private local state, not project source files.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Saving analysis cache...", "Analysis cached"),
      inputSchema: {
        projectId: z.string(),
        task: z.string().min(1).max(1000),
        role: z.string().max(200).optional(),
        files: z.array(z.string()).max(50).optional(),
        value: z.string().min(1).max(30_000),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "analysis_cache_put", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const snapshot = await fingerprintProject(entry.root, input.files);
        const key = resultCacheKey(input.task, input.role ?? null, snapshot.fingerprint);
        const memory = new ProjectMemoryStore(ctx.stateDir);
        await memory.putResult(input.projectId, {
          key,
          task: redact(input.task),
          role: input.role ? redact(input.role) : null,
          fingerprint: snapshot.fingerprint,
          value: redact(input.value),
        });
        return makeResult(
          { stored: true, cacheKey: key, fingerprint: snapshot.fingerprint, revision: snapshot.revision, dirty: snapshot.dirty },
          "Analysis result cached in JK private local state.",
        );
      });
    },
  );

  registerTool(
    "known_fix_search",
    {
      title: "Search known fixes",
      description: "Search project-specific fixes learned from earlier debugging before spending another model pass on the same failure pattern.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Searching known fixes...", "Known-fix search complete"),
      inputSchema: {
        projectId: z.string(),
        query: z.string().default(""),
        maxResults: z.number().int().min(1).max(20).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "known_fix_search", input, async () => {
        await resolveOrThrow(ctx, { projectId: input.projectId });
        const memory = new ProjectMemoryStore(ctx.stateDir);
        const fixes = await memory.searchKnownFixes(input.projectId, input.query, input.maxResults ?? 5);
        return makeResult({ fixes }, `Found ${fixes.length} matching known fix(es).`);
      });
    },
  );

  registerTool(
    "known_fix_add",
    {
      title: "Remember known fix",
      description:
        "Remember a verified project-specific symptom and solution in JK private local state. Duplicate title+symptom entries are updated instead of multiplied.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Remembering fix...", "Known fix saved"),
      inputSchema: {
        projectId: z.string(),
        title: z.string().min(1).max(200),
        symptom: z.string().min(1).max(1500),
        solution: z.string().min(1).max(5000),
        tags: z.array(z.string().min(1).max(80)).max(20).optional(),
        files: z.array(z.string().min(1).max(500)).max(20).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "known_fix_add", input, async () => {
        await resolveOrThrow(ctx, { projectId: input.projectId });
        const memory = new ProjectMemoryStore(ctx.stateDir);
        const fix = await memory.addKnownFix(input.projectId, {
          title: redact(input.title),
          symptom: redact(input.symptom),
          solution: redact(input.solution),
          tags: input.tags?.map((value) => redact(value)),
          files: input.files?.map((value) => redact(value)),
        });
        return makeResult({ fix }, `Known fix saved: ${fix.title}`);
      });
    },
  );

  registerTool(
    "file_read_slice",
    {
      title: "Read file slice",
      description: "Read a line-range slice of a project file with per-line and range SHA-256 hashes.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Reading file slice...", "File slice loaded"),
      inputSchema: {
        projectId: z.string(),
        workSessionId: WorkSessionIdSchema.optional(),
        path: z.string(),
        start: z.number().int().min(1).optional(),
        end: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "file_read_slice", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const start = input.start ?? (input.offset !== undefined ? input.offset + 1 : undefined);
        const slice: WorkContextSlice = isRemoteProject(entry)
          ? await dispatchExecutorJob<WorkContextSlice>(
              ctx.stateDir,
              entry.executorId,
              "file_read_slice",
              remotePayload(entry, { path: input.path, start, end: input.end }),
            )
          : await (async () => {
              const abs = await resolveInProject(entry.root, input.path, { allowSymlink: false });
              await guardSecretPath(ctx, abs, "file_read_slice");
              return await readSlice(entry.root, input.path, start, input.end);
            })();
        await recordRecentWork(ctx, {
          projectId: input.projectId,
          workSessionId: input.workSessionId,
          path: input.path,
          fileHash: slice.fullFileHash ?? null,
          lastAction: "read",
          start: slice.start,
          end: slice.end,
        });
        return makeResult(
          { ...slice, content: redact(slice.content), workContextFileHash: slice.fullFileHash ?? null,
            tokenStatus: slice.fullFileHash ? "same-buffer" : "unverified-worker-digest" },
          `Read ${input.path} lines ${slice.start}-${slice.end}.`,
        );
      });
    },
  );
}

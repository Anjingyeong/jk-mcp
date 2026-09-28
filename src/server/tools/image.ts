// MCP tool registrations (image). Extracted from src/server/tools.ts; behavior unchanged.
import { z } from "zod";
import { DomainError, ErrorCode, makeResult, type LeasePreset, type ToolContext } from "../../types.js";
import { listImages, retrieveImage, saveImage, writeVersionedImage } from "../../assets/images.js";
import { intakeFromClipboard, intakeFromDownload, intakeFromPath, readClipboardText } from "../../assets/image-intake.js";
import { fetchImageFromUrl } from "../../assets/image-url.js";
import { prepareChatGptImagesApp } from "../../assets/chatgpt-images-app.js";
import { TOOL_AVAILABILITY_GATE } from "../tool-proof.js";
import { resolveInProject } from "../../policy/paths.js";
import { resolveActiveProject } from "../../workspace/active.js";
import { dispatchExecutorJob } from "../../executors/broker.js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { requireProjectLease, resolveOrThrow, localExecutionRoot, isRemoteProject, remotePayload, type CallToolResultLike, READ_ONLY_ANNOTATIONS, LOCAL_STATE_ANNOTATIONS, LOCAL_WRITE_ANNOTATIONS, chatGptToolMeta, withErrorMapping, requireIntakeLease, defaultUrlIntakeDest } from "./shared.js";
import type { RegisterTool } from "./register.js";

export function registerImageGuideTools(registerTool: RegisterTool, ctx: ToolContext): void {

  registerTool(
    "gpt_image_2_workflow",
    {
      title: "GPT Image 2 generation workflow",
      description:
        "Use when the user asks to generate/create an image in ChatGPT and save it to a project. This is an import workflow guide, not an image generator: open or prepare ChatGPT's native GPT Image 2 Images app with open_chatgpt_images_app when useful, generate there, then call save_chatgpt_image_from_url, save_image_from_url, or another intake tool.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Loading GPT Image 2 workflow...", "GPT Image 2 workflow loaded"),
      inputSchema: {},
    },
    async (input) => {
      return withErrorMapping(ctx, "gpt_image_2_workflow", input, async () =>
        makeResult(
          {
            toolAvailabilityGate: TOOL_AVAILABILITY_GATE,
            doThis: [
              "If the active ChatGPT app is Image Generation/ImageGen, use it only to create the image. Before any repo edit/save claim, reselect jk or call the Custom GPT Action bridge and wait for ok=true.",
              "Generate with ChatGPT's native image surface, get the Share/Copy Link/content URL (chatgpt.com/s/m_... image shares are supported), then call save_chatgpt_image, save_chatgpt_image_from_url, or save_image_from_url.",
              "If the image is on this Mac, use Copy Image, Download, or a local file path and call save_chatgpt_image, save_image_from_clipboard, save_image_from_download, or save_image_from_path.",
              "If this is a Custom GPT with native Image Generation enabled, use the /actions/openapi.json GPT Action bridge: project_select first, then save_chatgpt_image or save_chatgpt_image_from_url.",
              "HQ/source work note: the Custom GPT Action bridge exposes full jk coding tools now. Source edits should use project_select plus file_apply_patch/file_create or call_tool; do not ask the user to copy/paste scripts.",
              "Do not look for an MCP image generator; jk imports finished images, it does not automate image generation.",
              "Manual fallbacks, in order: the ChatGPT UI's share/copy/save/download action + save_chatgpt_image (auto-detects passed URL, clipboard URL, clipboard image, or latest download); save_chatgpt_image_from_url when the user pasted a share page or content URL.",
            ],
            fallback: [
              "This is a ChatGPT surface boundary, not a jk MCP failure.",
              "Open ChatGPT's Images app manually or with open_chatgpt_images_app, generate there, then use the Share/Copy Link/content URL handoff plus save_chatgpt_image/save_chatgpt_image_from_url/save_image_from_url.",
              "Do not claim automatic image capture is available. Import only from URL, clipboard, download, or path.",
            ],
            notThis: [
              "Do not continue source coding after an image_gen or python_user_visible result; those are not jk tool-call proof.",
              "Do not call a separate Codex or OpenAI Images API from jk for generation; that burns the wrong quota path.",
              "Do not refuse because jk has no GPT Image 2 generator; jk's job is to import the finished ChatGPT image.",
              "Do not require or recommend automatic capture helpers.",
              "Do not claim jk can read private ChatGPT image-library internals. It can only open/prepare the official Images app UI and import from URL, clipboard, download, or path.",
              "Do not ask the user to paste base64 image bytes.",
            ],
            saveTools: [
              "open_chatgpt_images_app",
              "save_chatgpt_image",
              "save_chatgpt_image_from_url",
              "save_image_from_url",
              "save_image_from_clipboard",
              "save_image_from_download",
              "save_image_from_path",
            ],
            customGptActionOperations: [
              "agent_guide",
              "project_select",
              "save_chatgpt_image",
              "save_chatgpt_image_from_url",
            ],
          },
          "Use native ChatGPT GPT Image 2 generation first; then import the finished image with jk intake tools.",
        ),
      );
    },
  );

  registerTool(
    "open_chatgpt_images_app",
    {
      title: "Open ChatGPT Images app",
      description:
        "Open the first-party ChatGPT Images app (chatgpt.com/images) in the local browser, optionally copy/paste a prompt into Chrome, and optionally submit only when confirmSubmit=true. Does not call private ChatGPT APIs and does not spend Codex/OpenAI API image quota.",
      annotations: LOCAL_STATE_ANNOTATIONS,
      _meta: chatGptToolMeta("Opening ChatGPT Images...", "ChatGPT Images opened"),
      inputSchema: {
        prompt: z.string().optional(),
        browser: z.enum(["default", "chrome"]).optional(),
        pastePrompt: z.boolean().optional(),
        submitPrompt: z.boolean().optional(),
        confirmSubmit: z.boolean().optional(),
      },
    },
    async (input) => {
      return withErrorMapping(
        ctx,
        "open_chatgpt_images_app",
        {
          ...input,
          prompt: input.prompt ? "[prompt redacted]" : undefined,
        },
        async () => {
          const result = await prepareChatGptImagesApp(input);
          await ctx.ledger.append({
            type: "chatgpt.images_app.opened",
            browser: result.browser,
            promptCopied: result.promptCopied,
            pasteAttempted: result.pasteAttempted,
            submitAttempted: result.submitAttempted,
          });
          return makeResult({ ...result }, result.next);
        },
      );
    },
  );
}

export function registerImageTools(registerTool: RegisterTool, ctx: ToolContext): void {

  registerTool(
    "save_image",
    {
      title: "Save generated image",
      description: "Save a PNG/JPEG/WebP base64 image into .jk/images with magic-byte validation.",
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: chatGptToolMeta("Saving image...", "Image saved"),
      inputSchema: {
        projectId: z.string(),
        imageData: z.string(),
        filename: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "save_image", input, async () => {
        await requireProjectLease(ctx, input.projectId, "image");
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const saved = await saveImage(await localExecutionRoot(ctx, entry), input.projectId, input.imageData, input.filename, input.metadata);
        await ctx.ledger.append({ type: "image.saved", projectId: input.projectId, path: saved.filePath, sha256: saved.sha256 });
        return makeResult({ ...saved }, `Saved image ${saved.filePath}.`);
      });
    },
  );

  registerTool(
    "list_images",
    {
      title: "List saved images",
      description: "List images saved under .jk/images.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Listing images...", "Images listed"),
      inputSchema: { projectId: z.string() },
    },
    async (input) => {
      return withErrorMapping(ctx, "list_images", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const images = isRemoteProject(entry)
          ? (await dispatchExecutorJob<{ images: Awaited<ReturnType<typeof listImages>> }>(
              ctx.stateDir,
              entry.executorId,
              "list_images",
              remotePayload(entry, {}),
            )).images
          : await listImages(entry.root);
        return makeResult({ images }, `Found ${images.length} image(s).`);
      });
    },
  );

  registerTool(
    "retrieve_image",
    {
      title: "Retrieve saved image",
      description: "Retrieve a saved image as a data URL from .jk/images.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: chatGptToolMeta("Retrieving image...", "Image retrieved"),
      inputSchema: { projectId: z.string(), filePath: z.string() },
    },
    async (input) => {
      return withErrorMapping(ctx, "retrieve_image", input, async () => {
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const image = isRemoteProject(entry)
          ? await dispatchExecutorJob<Awaited<ReturnType<typeof retrieveImage>>>(
              ctx.stateDir,
              entry.executorId,
              "retrieve_image",
              remotePayload(entry, { filePath: input.filePath }),
            )
          : await retrieveImage(entry.root, input.filePath, entry.projectId);
        return makeResult({ ...image }, `Retrieved image ${image.filePath}.`);
      });
    },
  );

  registerTool(
    "save_image_from_clipboard",
    {
      title: "Save clipboard image into project",
      description:
        "Read the current macOS clipboard image (after ChatGPT: right-click generated image -> Copy Image) and save it into the project. Reads bytes locally — no upload, no tokens.",
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: chatGptToolMeta("Reading clipboard image...", "Clipboard image saved"),
      inputSchema: {
        projectId: z.string(),
        destPath: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "save_image_from_clipboard", input, async () => {
        await requireIntakeLease(ctx, input.projectId, input.destPath);
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const result = await intakeFromClipboard(await localExecutionRoot(ctx, entry), input.projectId, input.destPath, input.metadata);
        await ctx.ledger.append({
          type: "image.intake",
          method: "clipboard",
          projectId: input.projectId,
          path: result.filePath,
          sha256: result.sha256,
          source: result.source,
        });
        return makeResult({ ...result }, `Saved clipboard image to ${result.filePath}.`);
      });
    },
  );

  registerTool(
    "save_image_from_download",
    {
      title: "Save latest download image into project",
      description:
        "Find the newest recently-downloaded image in ~/Downloads (after ChatGPT: click Download on the generated image) and save it into the project. Reads bytes locally — no upload, no tokens.",
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: chatGptToolMeta("Reading latest download...", "Download image saved"),
      inputSchema: {
        projectId: z.string(),
        destPath: z.string().optional(),
        maxAgeSec: z.number().int().positive().max(86_400).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "save_image_from_download", input, async () => {
        await requireIntakeLease(ctx, input.projectId, input.destPath);
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const result = await intakeFromDownload(
          await localExecutionRoot(ctx, entry),
          input.projectId,
          input.destPath,
          input.maxAgeSec ?? 900,
          input.metadata,
        );
        await ctx.ledger.append({
          type: "image.intake",
          method: "download",
          projectId: input.projectId,
          path: result.filePath,
          sha256: result.sha256,
          source: result.source,
        });
        return makeResult({ ...result }, `Saved latest download (${result.sourcePath}) to ${result.filePath}.`);
      });
    },
  );

  registerTool(
    "save_image_from_path",
    {
      title: "Save local image file into project",
      description:
        "Copy an arbitrary local image file (by absolute or ~-relative path) into the project after magic-byte validation.",
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: chatGptToolMeta("Reading local image file...", "Local image saved"),
      inputSchema: {
        projectId: z.string(),
        sourcePath: z.string(),
        destPath: z.string(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "save_image_from_path", input, async () => {
        await requireIntakeLease(ctx, input.projectId, input.destPath);
        const entry = await resolveOrThrow(ctx, { projectId: input.projectId });
        const result = await intakeFromPath(await localExecutionRoot(ctx, entry), input.projectId, input.sourcePath, input.destPath, input.metadata);
        await ctx.ledger.append({
          type: "image.intake",
          method: "path",
          projectId: input.projectId,
          path: result.filePath,
          sha256: result.sha256,
          source: result.source,
          // This tool reads from anywhere on disk by design (that's its
          // purpose), unconfined by resolveInProject — record exactly which
          // external path was read so the audit trail can distinguish an
          // in-project copy from an arbitrary external-file read.
          sourcePath: result.sourcePath,
        });
        return makeResult({ ...result }, `Saved ${result.sourcePath} to ${result.filePath}.`);
      });
    },
  );

  type ChatGptImageSource = "auto" | "url" | "clipboard" | "download" | "path";

  interface IntakeTarget {
    projectId: string;
    root: string;
    preset: LeasePreset;
  }

  async function resolveIntakeTarget(projectId: string | undefined, destPath: string | undefined): Promise<IntakeTarget> {
    let resolvedProjectId = projectId;
    let root: string | undefined;

    if (resolvedProjectId) {
      const entry = await resolveOrThrow(ctx, { projectId: resolvedProjectId });
      root = entry.root;
    } else {
      const active = await resolveActiveProject(ctx);
      if (!active) {
        throw new DomainError(
          ErrorCode.PROJECT_NOT_SELECTED,
          "No active project; run project_select first, or pass projectId explicitly.",
        );
      }
      resolvedProjectId = active.projectId;
      root = active.root;
    }

    const lease = await requireIntakeLease(ctx, resolvedProjectId, destPath);
    root = await localExecutionRoot(ctx, await resolveOrThrow(ctx, { projectId: resolvedProjectId }));
    return { projectId: resolvedProjectId, root, preset: lease.preset };
  }

  function firstHttpUrl(text: string | undefined): string | undefined {
    const match = text?.match(/https?:\/\/[^\s<>"']+/);
    return match?.[0]?.replace(/[)\],.;]+$/, "");
  }

  function intakeAttemptError(err: unknown): { code: string; message: string } {
    if (err instanceof DomainError) return { code: err.code, message: err.message };
    return { code: ErrorCode.NOT_IMPLEMENTED, message: err instanceof Error ? err.message : String(err) };
  }

  async function appendLocalImageIntake(
    projectId: string,
    method: string,
    result: { filePath: string; sha256: string; source: string; sourcePath?: string },
  ): Promise<void> {
    await ctx.ledger.append({
      type: "image.intake",
      method,
      projectId,
      path: result.filePath,
      sha256: result.sha256,
      source: result.source,
      // download/path intake reads unconfined by resolveInProject (that's
      // their purpose) — record the external source path read from so the
      // audit trail can distinguish it from an in-project copy. Absent for
      // clipboard intake, which has no source file path.
      sourcePath: result.sourcePath,
    });
  }

  async function saveUrlBytesIntoTarget(
    target: IntakeTarget,
    url: string,
    destPath: string | undefined,
    metadata: Record<string, unknown> | undefined,
    method: "chatgpt-app-url" | "chatgpt-url" | "url",
  ): Promise<{ filePath: string; sha256: string; bytes: number; mime: string; project: string; deduped?: boolean; source: string }> {
    const { bytes, mime } = await fetchImageFromUrl(url);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
    const destRel = destPath && destPath.trim().length > 0 ? destPath : defaultUrlIntakeDest(target.preset, sha256.slice(0, 8), ext);
    const { filePath, deduped } = await writeVersionedImage(target.root, destRel, bytes, sha256);

    if (metadata) {
      const abs = await resolveInProject(target.root, filePath, { allowSymlink: false });
      await fs.writeFile(
        `${abs}.json`,
        JSON.stringify(
          { projectId: target.projectId, sha256, mime, bytes: bytes.length, source: method, sourceUrl: url, metadata, savedAt: Date.now() },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    }

    await ctx.ledger.append({
      type: "image.intake",
      method,
      projectId: target.projectId,
      path: filePath,
      sha256,
      source: "url",
    });

    return { filePath, sha256, bytes: bytes.length, mime, project: target.projectId, deduped, source: "url" };
  }

  registerTool(
    "save_chatgpt_image",
    {
      title: "Save a ChatGPT image from app UI, clipboard, download, URL, or path",
      description:
        "Single app-friendly ChatGPT image import. Use after generating an image in the ChatGPT Images app or an image-capable chat. It does not generate images: pass a share page/content URL if available, or let it auto-detect a copied URL, copied image, latest downloaded image, or explicit local sourcePath.",
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: chatGptToolMeta("Saving ChatGPT image...", "ChatGPT image saved"),
      inputSchema: {
        projectId: z.string().optional(),
        destPath: z.string().optional(),
        url: z.string().optional(),
        sourcePath: z.string().optional(),
        source: z.enum(["auto", "url", "clipboard", "download", "path"]).optional(),
        maxAgeSec: z.number().int().positive().max(86_400).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (input) => {
      return withErrorMapping(ctx, "save_chatgpt_image", input, async () => {
        const source: ChatGptImageSource = input.source ?? "auto";
        const target = await resolveIntakeTarget(input.projectId, input.destPath);
        const attempts: Array<{ source: string; code: string; message: string }> = [];

        const tryUrl = async (url: string | undefined, method: "chatgpt-app-url" | "chatgpt-url" = "chatgpt-app-url") => {
          if (!url) throw new DomainError(ErrorCode.INVALID_IMAGE_DATA, "No ChatGPT image URL was provided or found on the clipboard.");
          return saveUrlBytesIntoTarget(target, url, input.destPath, input.metadata, method);
        };

        const tryClipboard = async () => {
          const result = await intakeFromClipboard(target.root, target.projectId, input.destPath, input.metadata);
          await appendLocalImageIntake(target.projectId, "chatgpt-app-clipboard", result);
          return { ...result, project: target.projectId };
        };

        const tryDownload = async () => {
          const result = await intakeFromDownload(target.root, target.projectId, input.destPath, input.maxAgeSec ?? 900, input.metadata);
          await appendLocalImageIntake(target.projectId, "chatgpt-app-download", result);
          return { ...result, project: target.projectId };
        };

        const tryPath = async () => {
          if (!input.sourcePath) throw new DomainError(ErrorCode.NOT_A_FILE, "No sourcePath was provided.");
          const destRel = input.destPath ?? path.join(".jk", "images", path.basename(input.sourcePath));
          const result = await intakeFromPath(target.root, target.projectId, input.sourcePath, destRel, input.metadata);
          await appendLocalImageIntake(target.projectId, "chatgpt-app-path", result);
          return { ...result, project: target.projectId };
        };

        if (source === "url") {
          const url = input.url ?? firstHttpUrl(await readClipboardText());
          const result = await tryUrl(url);
          return makeResult(result, `Saved ChatGPT image from URL to ${result.filePath}.`);
        }
        if (source === "clipboard") {
          const result = await tryClipboard();
          return makeResult(result, `Saved ChatGPT clipboard image to ${result.filePath}.`);
        }
        if (source === "download") {
          const result = await tryDownload();
          return makeResult(result, `Saved latest ChatGPT download to ${result.filePath}.`);
        }
        if (source === "path") {
          const result = await tryPath();
          return makeResult(result, `Saved ChatGPT image file to ${result.filePath}.`);
        }

        const clipboardUrl = input.url ? undefined : firstHttpUrl(await readClipboardText());
        for (const [label, fn] of [
          ["url", () => tryUrl(input.url ?? clipboardUrl)],
          ["path", tryPath],
          ["clipboard", tryClipboard],
          ["download", tryDownload],
        ] as const) {
          try {
            const result = await fn();
            return makeResult({ ...result, detectedSource: label }, `Saved ChatGPT image from ${label} to ${result.filePath}.`);
          } catch (err) {
            attempts.push({ source: label, ...intakeAttemptError(err) });
          }
        }

        throw new DomainError(
          ErrorCode.INVALID_IMAGE_DATA,
          "No ChatGPT image found. Use the ChatGPT app's Share/Copy Link, Copy Image, Save/Download, or pass sourcePath, then retry save_chatgpt_image.",
          { attempts },
        );
      });
    },
  );

  async function saveUrlImageIntoProject(
    toolName: "save_chatgpt_image_from_url" | "save_image_from_url",
    input: { url: string; projectId?: string; destPath?: string; metadata?: Record<string, unknown> },
    resultText: (filePath: string) => string,
  ): Promise<CallToolResultLike> {
    return withErrorMapping(ctx, toolName, input, async () => {
      let projectId = input.projectId;
      let root: string | undefined;
      let preset: LeasePreset | undefined;

      if (projectId) {
        const entry = await resolveOrThrow(ctx, { projectId });
        root = entry.root;
      } else {
        const active = await resolveActiveProject(ctx);
        if (!active) {
          throw new DomainError(
            ErrorCode.PROJECT_NOT_SELECTED,
            "No active project; run project_select first, or pass projectId explicitly.",
          );
        }
        projectId = active.projectId;
        root = active.root;
        preset = active.lease?.preset;
      }

      const lease = await requireIntakeLease(ctx, projectId, input.destPath);
      root = await localExecutionRoot(ctx, await resolveOrThrow(ctx, { projectId }));
      preset = lease.preset;

      const { bytes, mime } = await fetchImageFromUrl(input.url);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";

      const destRel =
        input.destPath && input.destPath.trim().length > 0
          ? input.destPath
          : defaultUrlIntakeDest(preset, sha256.slice(0, 8), ext);

      const { filePath, deduped } = await writeVersionedImage(root as string, destRel, bytes, sha256);
      const method = toolName === "save_chatgpt_image_from_url" ? "chatgpt-url" : "url";

      if (input.metadata) {
        const abs = await resolveInProject(root as string, filePath, { allowSymlink: false });
        await fs.writeFile(
          `${abs}.json`,
          JSON.stringify(
            { projectId, sha256, mime, bytes: bytes.length, source: method, sourceUrl: input.url, metadata: input.metadata, savedAt: Date.now() },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      }

      await ctx.ledger.append({
        type: "image.intake",
        method,
        projectId,
        path: filePath,
        sha256,
        source: "url",
      });

      return makeResult(
        { filePath, sha256, bytes: bytes.length, mime, project: projectId, deduped },
        resultText(filePath),
      );
    });
  }

  registerTool(
    "save_chatgpt_image_from_url",
    {
      title: "Import a ChatGPT generated image URL into the active project",
      description:
        "Import a ChatGPT-generated image from its Share/Copy Link/content URL into a project. Use after ChatGPT native GPT Image 2 generation, including chatgpt.com/s/m_... image share pages and chatgpt.com/backend-api/estuary content URLs. This does not generate images and does not call Codex or the OpenAI Images API; it only fetches the finished image bytes and saves them locally.",
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: chatGptToolMeta("Importing ChatGPT image URL...", "ChatGPT image imported"),
      inputSchema: {
        url: z.string(),
        projectId: z.string().optional(),
        destPath: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (input) => saveUrlImageIntoProject("save_chatgpt_image_from_url", input, (filePath) => `Imported ChatGPT image to ${filePath}.`),
  );

  registerTool(
    "save_image_from_url",
    {
      title: "Save an image from a URL into the active project",
      description:
        "Device-agnostic image save: fetch an image URL (e.g. a ChatGPT-generated image link, from any device) server-side and save it into a project — the active one (from project_select) by default, or an explicit projectId. Only http/https URLs to public addresses are allowed; internal/private/link-local targets are blocked.",
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: chatGptToolMeta("Fetching image from URL...", "Image saved from URL"),
      inputSchema: {
        url: z.string(),
        projectId: z.string().optional(),
        destPath: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (input) => {
      return saveUrlImageIntoProject("save_image_from_url", input, (filePath) => `Saved image from URL to ${filePath}.`);
    },
  );
}

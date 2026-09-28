// MCP tool registrations (control). Extracted from src/server/tools.ts; behavior unchanged.
import { z } from "zod";
import { type ToolContext } from "../../types.js";
import { isControlEnabled } from "../../control/policy.js";
import { handleComputerActionStatus, handleComputerKillSwitch, handleComputerRequestAction, handleComputerScreenshot } from "../../control/tools.js";
import { READ_ONLY_ANNOTATIONS, CONTROL_ANNOTATIONS, chatGptToolMeta } from "./shared.js";
import type { RegisterTool } from "./register.js";

export function registerControlTools(registerTool: RegisterTool, ctx: ToolContext): void {
  // -------------------------------------------------------------------
  // Human-confirmed desktop control (registered only when the install-time
  // JK_CONTROL feature flag is on). These 4 tools are additionally
  // hidden from CHATGPT_TO_CODEX's tools/list (installChatGptToolListHandler
  // below) and blocked on the generic call-tool bridge
  // (src/server/actions.ts callRegisteredTool) via CONTROL_TOOL_NAMES unless
  // the owner separately opts in with JK_CONTROL_CHATGPT
  // (isControlChatGptExposed) — the public-product default keeps both closed,
  // registering them here alone never exposes them to ChatGPT.
  // -------------------------------------------------------------------
  if (isControlEnabled()) {
    const controlTargetSchema = z
      .object({
        ax: z
          .object({
            // `role` is interpolated as a raw AppleScript element class (e.g.
            // "button", "text field") into `every <role> of ...` /
            // `first <role> whose ...` in src/control/mac-input.ts — it is
            // never quoted like a string literal, because AppleScript class
            // names cannot be quoted. An unconstrained string here would let
            // untrusted input close the enclosing script clause and inject
            // arbitrary AppleScript (including `do shell script`). Restrict
            // to the shape of real System Events AX class names.
            role: z.string().regex(/^[A-Za-z][A-Za-z ]{0,40}$/, "role must be a plain AX class name (letters and spaces only)"),
            title: z.string().optional(),
            label: z.string().optional(),
            description: z.string().optional(),
          })
          .optional(),
        windowPoint: z.object({ xRel: z.number().min(0).max(1), yRel: z.number().min(0).max(1) }).optional(),
      })
      .refine((v) => Boolean(v.ax) || Boolean(v.windowPoint), { message: "target requires ax or windowPoint" });

    registerTool(
      "computer_screenshot",
      {
        title: "Capture a desktop screenshot (control)",
        description:
          "Capture the full screen or a specific app window for human-in-the-loop desktop control. No synthetic input; requires an active control lease (project_select preset=control). When the owner has opted in via JK_CONTROL_CHATGPT, this tool is visible to ChatGPT and its client-side Confirm/Deny prompt (from the non-read-only annotation below) is the approval gate before capture happens. Refuses to capture sensitive apps (password managers, Keychain Access, System Settings, banking/2FA apps).",
        annotations: CONTROL_ANNOTATIONS,
        _meta: chatGptToolMeta("Capturing desktop screenshot...", "Desktop screenshot captured"),
        inputSchema: {
          appName: z.string().optional(),
          label: z.string().optional(),
          waitMs: z.number().int().min(0).max(30_000).optional(),
        },
      },
      async (input) => handleComputerScreenshot(ctx, input),
    );

    registerTool(
      "computer_request_action",
      {
        title: "Request a desktop click/type/key/scroll action (control)",
        description:
          "Request one click/type/key/scroll action. Requires an active control lease (preset=control), which the owner can arm from JK Control Center. On Windows V1, click/type/scroll use a relative windowPoint and keyCode is a Windows virtual-key code; UIA semantic targeting is intentionally not part of V1. By default (JK_CONTROL_CHATGPT off, or this tool called outside ChatGPT) the request is queued for owner approval. When the owner opts in via JK_CONTROL_CHATGPT, the ChatGPT Confirm/Deny prompt can approve one action at a time. The kill switch, allowlist, sensitive-app denylist, live foreground-target check, and audit trail remain enforced.",
        annotations: CONTROL_ANNOTATIONS,
        inputSchema: {
          appName: z.string().min(1),
          kind: z.enum(["click", "type", "key", "scroll"]),
          target: controlTargetSchema,
          text: z.string().optional(),
          keyCode: z.number().int().min(0).optional(),
          scrollDelta: z.number().int().min(-20).max(20).optional(),
          reason: z.string().min(1),
        },
        _meta: chatGptToolMeta("Confirming desktop action...", "Desktop action executed"),
      },
      async (input) => handleComputerRequestAction(ctx, input),
    );

    registerTool(
      "computer_action_status",
      {
        title: "Check desktop control action status (control)",
        description:
          "Read-only status check for one queued action (by actionId) or the whole current-session queue: pending/approved/rejected/done, never a trigger to execute anything. Requires an active control lease.",
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: chatGptToolMeta("Checking desktop control status...", "Desktop control status loaded"),
        inputSchema: {
          actionId: z
            .string()
            .regex(/^ctl_[0-9a-fA-F-]{36}$/, "actionId must be a control action id issued by computer_request_action")
            .optional(),
        },
      },
      async (input) => handleComputerActionStatus(ctx, input),
    );

    registerTool(
      "computer_kill_switch",
      {
        title: "Kill the desktop control session (control)",
        description:
          "Immediately disable desktop control for this session: rejects every pending action and blocks new requests until a fresh control lease (project_select preset=control) is granted. Idempotent. Requires an active control lease. Available to ChatGPT (as a normal Confirm/Deny action) whenever the desktop-control tools are exposed, so the owner can kill an in-progress session from the same phone that confirmed it.",
        annotations: CONTROL_ANNOTATIONS,
        _meta: chatGptToolMeta("Killing desktop control session...", "Desktop control session killed"),
        inputSchema: {
          reason: z.string().optional(),
        },
      },
      async (input) => handleComputerKillSwitch(ctx, input),
    );
  }
}

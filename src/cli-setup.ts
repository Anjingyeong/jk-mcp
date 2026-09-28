/**
 * Pure helpers for `jk setup` / `jk start` (kept out of cli.ts so tests can
 * import them without executing the CLI entrypoint).
 */

/** The one command beginners re-run; published as the `jk-mcp` npm package. */
export const SETUP_COMMAND = "npx -y jk-mcp setup";

export interface HttpReadyInfo {
  connectorUrl: string;
  localBaseUrl: string;
  workspaceRoot: string;
  quickTunnel: boolean;
}

/** Accepts `mcp.example.com`, `https://mcp.example.com`, or `.../mcp`; returns the HTTPS origin. */
export function normalizeSetupPublicUrl(value: string): string {
  const raw = value.trim().replace(/^['"]|['"]$/g, "");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("Enter a valid HTTPS address, for example: https://mcp.example.com");
  }
  if (parsed.protocol !== "https:") throw new Error("A fixed ChatGPT connector address must use HTTPS.");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Use only the public HTTPS origin, for example: https://mcp.example.com");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname && pathname !== "/mcp") {
    throw new Error("Use the domain only (or a trailing /mcp), for example: https://mcp.example.com");
  }
  return parsed.origin;
}

/**
 * Terminal banner. URLs are printed on their own lines so terminals that
 * linkify (Windows Terminal, VS Code, iTerm2) allow Ctrl/Cmd+click.
 * The connection code appears only when it was just generated: JK stores a
 * hash, so an existing code can never be shown again.
 */
export function formatSetupReady(info: HttpReadyInfo, connectionCode: string | undefined): string[] {
  const lines = [
    "",
    "============================================================",
    " JK is ready for ChatGPT",
    "============================================================",
    " Connector URL (paste into ChatGPT > Apps & Connectors):",
    "",
    `   ${info.connectorUrl}`,
    "",
  ];
  if (info.quickTunnel) {
    lines.push(" ! Temporary Quick Tunnel address: it CHANGES every time JK restarts.");
    lines.push("   After a restart, update the connector URL in ChatGPT and log in again.");
    lines.push("   For a permanent address, run setup with --public-url https://mcp.example.com");
    lines.push("");
  }
  if (connectionCode) {
    lines.push(" Connection code (Owner Token) - shown ONCE, paste it into the JK login window:");
    lines.push("");
    lines.push(`   ${connectionCode}`);
    lines.push("");
    lines.push("   Save it somewhere private. Never share it in chats, screenshots, or issues.");
  } else {
    lines.push(" Your existing connection code is still active.");
    lines.push(` Lost it? Stop JK with Ctrl+C and run \`${SETUP_COMMAND} --reset-code\`.`);
  }
  lines.push("");
  lines.push(` Control Center:  ${info.localBaseUrl}/`);
  lines.push(` Health check:    ${info.localBaseUrl}/healthz`);
  lines.push(` Allowed folder:  ${info.workspaceRoot}`);
  lines.push("");
  lines.push(" Try in a new ChatGPT chat:  @jk 프로젝트 목록 보여줘");
  lines.push(" Keep this window open while you use JK. Next time, run the same command again.");
  lines.push("============================================================");
  return lines;
}

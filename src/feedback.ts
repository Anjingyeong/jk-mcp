/**
 * Public feedback links shown in the Control Center and native apps.
 * Issue URLs prefill only non-sensitive facts (version, OS, surface); logs,
 * paths, and tokens are never added automatically.
 */
export const JK_PUBLIC_REPO_URL = "https://github.com/Anjingyeong/jk-mcp";
export const JK_ISSUES_URL = `${JK_PUBLIC_REPO_URL}/issues`;

export function buildIssueUrl(info: { version?: string; platform?: string; surface?: string }): string {
  const params = new URLSearchParams({ template: "bug_report.yml" });
  if (info.version) params.set("version", info.version);
  if (info.platform) params.set("os", info.platform);
  if (info.surface) params.set("surface", info.surface);
  return `${JK_ISSUES_URL}/new?${params.toString()}`;
}

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RUNTIME_MANIFEST_PREFLIGHT_MAX_LINES, runtimeUpgradeManifestFingerprint } from "./command.js";

describe("runtimeUpgradeManifestFingerprint", () => {
  it("allows remote preflight to read manifests larger than the old 200-line cap", () => {
    expect(RUNTIME_MANIFEST_PREFLIGHT_MAX_LINES).toBeGreaterThan(303);
  });

  it("accepts numbered Windows file_read_slice content and ignores generatedAt", () => {
    const manifest = {
      version: 1,
      generatedAt: "2026-10-07T07:31:37.084Z",
      sourceFingerprint: "a".repeat(64),
      buildFingerprint: "b".repeat(64),
    };
    const plain = JSON.stringify(manifest, null, 2);
    const numbered = plain.split("\n").map((line, index) => String(index + 1) + "\t" + line).join("\n");
    expect(runtimeUpgradeManifestFingerprint(numbered)).toBe(runtimeUpgradeManifestFingerprint(plain));

    const regenerated = JSON.stringify({ ...manifest, generatedAt: "2026-10-07T08:00:00.000Z" });
    expect(runtimeUpgradeManifestFingerprint(regenerated)).toBe(runtimeUpgradeManifestFingerprint(plain));
  });

  it("uses original line hashes when remote Windows redacts manifest fingerprint values", () => {
    const manifest = {
      version: 1,
      generatedAt: "2026-10-07T07:31:37.084Z",
      sourceFingerprint: "a".repeat(64),
      buildFingerprint: "b".repeat(64),
    };
    const originalLines = JSON.stringify(manifest, null, 2).split("\n");
    const lineHashes = originalLines.map((line) => createHash("sha256").update(line).digest("hex"));
    const redacted = originalLines
      .map((line) => line.replace(/"[ab]{64}"/u, '"[REDACTED]"'))
      .map((line, index) => String(index + 1) + "\t" + line)
      .join("\n");
    const first = runtimeUpgradeManifestFingerprint(redacted, lineHashes);

    const regeneratedLines = JSON.stringify({ ...manifest, generatedAt: "2026-10-07T08:00:00.000Z" }, null, 2).split("\n");
    const regeneratedHashes = regeneratedLines.map((line) => createHash("sha256").update(line).digest("hex"));
    const regeneratedRedacted = regeneratedLines
      .map((line) => line.replace(/"[ab]{64}"/u, '"[REDACTED]"'))
      .map((line, index) => String(index + 1) + "\t" + line)
      .join("\n");
    expect(runtimeUpgradeManifestFingerprint(regeneratedRedacted, regeneratedHashes)).toBe(first);
  });
});

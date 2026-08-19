import { describe, expect, it } from "vitest";
import * as localShell from "./local-shell.js";

const inspectShellCommand = localShell.inspectShellCommand;
const trustedOwnerRoutineNetwork = Object.values(localShell).find((value) => {
  if (typeof value !== "function") return false;
  try {
    const fn = value as (command: string) => unknown;
    return fn("curl https://example.com/status") === true && fn("ssh deploy@example.com") === false;
  } catch {
    return false;
  }
}) as ((command: string) => boolean) | undefined;

describe("trusted-owner routine network policy", () => {
  it("auto-allows routine project work but keeps direct shell push outside the trusted lane", () => {
    expect(trustedOwnerRoutineNetwork).toBeTypeOf("function");
    expect(trustedOwnerRoutineNetwork?.("git push origin main")).toBe(false);
    expect(trustedOwnerRoutineNetwork?.("curl https://example.com/status")).toBe(true);
    expect(trustedOwnerRoutineNetwork?.("npm install && curl https://example.com/status")).toBe(true);
    expect(
      trustedOwnerRoutineNetwork?.(
        "PYTHONPATH=src python3 -m ssalmeok.cli --source seoul-public > var/live.json",
      ),
    ).toBe(true);
    expect(
      trustedOwnerRoutineNetwork?.(
        "set -eu\npython3 -m ssalmeok.cli\ngit add .\ngit commit -m release\ngit push origin main",
      ),
    ).toBe(false);
  });

  it("keeps direct high-risk egress and broad external mutation approval-gated", () => {
    expect(trustedOwnerRoutineNetwork?.("git push --force-with-lease origin main")).toBe(false);
    expect(trustedOwnerRoutineNetwork?.("curl -X POST https://example.com -d x=1")).toBe(false);
    expect(trustedOwnerRoutineNetwork?.("ssh deploy@example.com")).toBe(false);
    expect(trustedOwnerRoutineNetwork?.("npm install -g wrangler")).toBe(false);
    expect(trustedOwnerRoutineNetwork?.("python3 -c \"print('network')\"")).toBe(false);
    expect(trustedOwnerRoutineNetwork?.("aws ec2 describe-instances")).toBe(false);
    expect(trustedOwnerRoutineNetwork?.("oci compute instance list --compartment-id ocid1.compartment.test")).toBe(false);
  });

  it("classifies history rewriting and direct schedule mutation as destructive", () => {
    expect(inspectShellCommand("git reset --hard HEAD~1").destructive).toBe(true);
    expect(inspectShellCommand("git rebase main").destructive).toBe(true);
    expect(inspectShellCommand("git push --force origin main").destructive).toBe(true);
    expect(inspectShellCommand("crontab -r").destructive).toBe(true);
    expect(inspectShellCommand("crontab /tmp/jobs").destructive).toBe(true);
    expect(inspectShellCommand("crontab -l").destructive).toBe(false);
    expect(inspectShellCommand("git push origin main").destructive).toBe(false);
  });
});

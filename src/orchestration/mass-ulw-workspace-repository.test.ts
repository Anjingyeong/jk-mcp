import type { ChildProcess, ExecFileException, ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
type Callback = (error: ExecFileException | null, stdout: string, stderr: string) => void;
// Mutable receipts record real child lifecycle events, not inferred promise state.
const children: { child: ChildProcess; command: string; closed: boolean; code: number | null; close: Promise<void> }[] = [];
const headCodes: (number | string | undefined)[] = [];
let root: string;
let holdTopLevel = false;
let holder: ChildProcess | undefined;
let ready: Promise<void> | undefined;

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Child lifecycle event timed out")), 15_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function execute(file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding, callback: Callback): ChildProcess {
  let child: ChildProcess;
  if (holdTopLevel && args.includes("--show-toplevel")) {
    // Substitute only the top-level query with a real cwd-owning child. Its
    // callback still fires on close, but stdin explicitly controls completion.
    child = actual.execFile(process.execPath, ["-e",
      "console.error('READY'); process.stdin.once('data', () => { console.log(process.cwd()); process.stdin.destroy(); });",
    ], options, callback);
    holder = child;
    ready = new Promise<void>((resolve, reject) => {
      let text = "";
      child.once("error", reject);
      child.stderr?.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        if (text.includes("READY\n")) resolve();
      });
    });
  } else {
    child = actual.execFile(file, args, options, (error, stdout, stderr) => {
      const deliver = () => {
        if (args.includes("HEAD^{commit}")) headCodes.push(error?.code ?? 0);
        callback(error, stdout, stderr);
      };
      // Fix the failing interleaving without relying on relative launch speed.
      if (error && args.includes("HEAD^{commit}") && ready) {
        void bounded(ready).then(deliver, (failure: unknown) => {
          callback(failure instanceof Error ? failure : new Error(String(failure)), "", "");
        });
      } else {
        deliver();
      }
    });
  }
  const receipt: (typeof children)[number] = {
    child, command: args.join(" "), closed: false, code: null,
    close: new Promise<void>((resolve) => child.once("close", (code) => {
      receipt.closed = true;
      receipt.code = code;
      resolve();
    })),
  };
  children.push(receipt);
  return child;
}

function executeAsync(file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => execute(file, args, options, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  }));
}

async function fixtureGit(args: string[]): Promise<string> {
  const result = await executeAsync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: root, encoding: "utf8", windowsHide: true,
  });
  return result.stdout.trim();
}

async function commitFixture(): Promise<string> {
  await fixtureGit(["-c", "commit.gpgsign=false", "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-q", "-m", "fixture"]);
  return fixtureGit(["rev-parse", "HEAD"]);
}

beforeEach(async () => {
  vi.resetModules();
  holdTopLevel = false;
  holder = undefined;
  ready = undefined;
  children.length = 0;
  headCodes.length = 0;
  Object.defineProperty(execute, promisify.custom, { value: executeAsync, configurable: true });
  vi.doMock("node:child_process", () => ({ ...actual, execFile: execute }));
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mass-ulw-repository-guard-"));
  await fixtureGit(["init", "-q"]);
});

afterEach(async () => {
  try {
    holder?.stdin?.end("RELEASE\n");
    await bounded(Promise.all(children.map((receipt) => receipt.close)));
    await fs.rm(root, { recursive: true, force: true });
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    console.log("[repository guard cleanup receipt]", JSON.stringify({
      root, removed: true,
      children: children.map(({ child, command, closed, code }) => ({ pid: child.pid, command, closed, code })),
    }));
  } finally {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
});

describe("repository guard child ownership", () => {
  it("has no surviving child at rejection when HEAD is missing", async () => {
    // Given an unborn Git repository and an explicitly held sibling query.
    holdTopLevel = true;
    const { requireRepositoryRoot } = await import("./mass-ulw-workspace-repository.js");

    // When the real HEAD query fails, observe the outward rejection immediately.
    const rejection = await bounded(requireRepositoryRoot(root).then(() => null, (error: unknown) => error));
    const survivingChildren = children.filter((receipt) => !receipt.closed);

    // Then no started child may retain the caller-owned root past rejection.
    console.log("[repository guard rejection receipt]", JSON.stringify({ root, headCodes, survivingChildren: survivingChildren.length }));
    expect(rejection).toBeInstanceOf(Error);
    expect(headCodes).toEqual([128]);
    expect(survivingChildren).toHaveLength(0);
  });

  it("returns the canonical root and commit when HEAD is valid", async () => {
    // Given a committed fixture, with both guard queries using real Git.
    const head = await commitFixture();
    const canonicalRoot = await fs.realpath(root);
    const { requireRepositoryRoot } = await import("./mass-ulw-workspace-repository.js");

    // When the caller supplies a path containing a redundant segment.
    const result = await bounded(requireRepositoryRoot(`${root}${path.sep}.`));

    // Then realpath normalization and the verified commit are preserved.
    expect(result).toEqual({ root: canonicalRoot, head });
    expect(headCodes).toEqual([0]);
    expect(children.filter((receipt) => !receipt.closed)).toHaveLength(0);
  });

  it("rejects a nested directory when HEAD is valid", async () => {
    // Given a real committed repository with a nested directory.
    await commitFixture();
    const nested = path.join(root, "nested");
    await fs.mkdir(nested);
    const { requireRepositoryRoot } = await import("./mass-ulw-workspace-repository.js");

    // When the caller supplies a directory other than the Git top-level.
    const rejection = await bounded(requireRepositoryRoot(nested).then(() => null, (error: unknown) => error));

    // Then successful HEAD verification does not bypass the top-level guard.
    expect(rejection).toBeInstanceOf(Error);
    expect(headCodes).toEqual([0]);
    expect(children.filter((receipt) => !receipt.closed)).toHaveLength(0);
  });
});

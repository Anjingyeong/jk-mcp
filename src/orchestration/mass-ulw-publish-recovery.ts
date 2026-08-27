import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJournal } from "./mass-ulw-workspace-changes.js";
import { absoluteFromRelative, readPathImage } from "./mass-ulw-workspace-repository.js";
import type {
  JournalRecord,
  MassUlwCommittedPublicationReceipt,
  MassUlwPublicationRecovery,
} from "./mass-ulw-workspace-types.js";

const PublishedPostimageSchema = z.object({
  path: z.string().min(1),
  exists: z.boolean(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const CommittedPublicationReceiptSchema = z.object({
  version: z.literal(1),
  repositoryRoot: z.string().min(1),
  integrationCommit: z.string().min(1),
  changedPaths: z.array(z.string().min(1)),
  laneCommits: z.array(z.object({
    id: z.string().min(1),
    commit: z.string().min(1),
    changedPaths: z.array(z.string().min(1)),
  }).strict()),
  publishFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  postimages: z.array(PublishedPostimageSchema),
}).strict() satisfies z.ZodType<MassUlwCommittedPublicationReceipt>;

const JournalSchema = z.object({
  version: z.literal(1),
  repositoryRoot: z.string().min(1),
  phase: z.enum(["prepared", "publishing", "committed", "rolling-back", "rolled-back"]),
  paths: z.array(z.string().min(1)),
  applied: z.array(z.string().min(1)),
  preexisting: z.array(z.string().min(1)),
  backedUp: z.array(z.string().min(1)),
  receipt: CommittedPublicationReceiptSchema.optional(),
}).strict();

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, (error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  });
}

export function massUlwPublishFingerprint(integrationCommit: string, changedPaths: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify({
    commit: integrationCommit,
    changedPaths: [...changedPaths].sort(),
  })).digest("hex");
}

export function publicationTransactionRoot(recoveryRoot: string, recoveryId: string): string {
  const digest = createHash("sha256").update(recoveryId).digest("hex");
  return path.resolve(recoveryRoot, "orchestration", "mass-ulw-publish", digest);
}

export async function rollbackMassUlwPublication(transactionRoot: string, journal: JournalRecord): Promise<void> {
  const journalPath = path.join(transactionRoot, "journal.json");
  const backupRoot = path.join(transactionRoot, "backup");
  journal.phase = "rolling-back";
  await writeJournal(journalPath, journal);
  const preexisting = new Set(journal.preexisting);
  for (const relative of [...journal.applied].reverse()) {
    const destination = absoluteFromRelative(journal.repositoryRoot, relative);
    const backup = absoluteFromRelative(backupRoot, relative);
    if (preexisting.has(relative) && await exists(backup)) {
      await rm(destination, { recursive: true, force: true });
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(backup, destination);
    } else if (preexisting.has(relative)) {
      if (!(await exists(destination))) throw new Error(`MASS ULW publish preimage and backup are both missing: ${relative}`);
    } else {
      await rm(destination, { recursive: true, force: true });
    }
  }
  journal.phase = "rolled-back";
  await writeJournal(journalPath, journal);
}

async function validateCommittedReceipt(receipt: MassUlwCommittedPublicationReceipt, repositoryRoot: string): Promise<void> {
  if (!samePath(receipt.repositoryRoot, repositoryRoot)) throw new Error("MASS ULW committed receipt repository does not match the routed project");
  if (receipt.publishFingerprint !== massUlwPublishFingerprint(receipt.integrationCommit, receipt.changedPaths)) {
    throw new Error("MASS ULW committed receipt fingerprint is invalid");
  }
  if (JSON.stringify(receipt.changedPaths) !== JSON.stringify(receipt.postimages.map((image) => image.path))) {
    throw new Error("MASS ULW committed receipt paths are invalid");
  }
  for (const expected of receipt.postimages) {
    const actual = await readPathImage(repositoryRoot, expected.path);
    const digest = createHash("sha256").update(actual.bytes).digest("hex");
    if (actual.exists !== expected.exists || digest !== expected.digest) {
      throw new Error(`MASS ULW committed publication bytes changed: ${expected.path}`);
    }
  }
}

export async function recoverMassUlwPublication(input: {
  recoveryRoot: string;
  recoveryId: string;
  repositoryRoot: string;
}): Promise<MassUlwPublicationRecovery> {
  const transactionRoot = publicationTransactionRoot(input.recoveryRoot, input.recoveryId);
  let raw: string;
  try {
    raw = await readFile(path.join(transactionRoot, "journal.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "none" };
    throw error;
  }
  const journal = JournalSchema.parse(JSON.parse(raw));
  if (!samePath(journal.repositoryRoot, input.repositoryRoot)) throw new Error("MASS ULW publication journal repository does not match the routed project");
  if (journal.phase === "committed") {
    const receipt = CommittedPublicationReceiptSchema.parse(journal.receipt);
    await validateCommittedReceipt(receipt, input.repositoryRoot);
    return { kind: "committed", receipt };
  }
  if (journal.phase !== "rolled-back") await rollbackMassUlwPublication(transactionRoot, journal);
  await rm(transactionRoot, { recursive: true, force: true });
  return { kind: "rolled-back" };
}

export async function finalizeMassUlwPublicationRecovery(recoveryRoot: string, recoveryId: string): Promise<void> {
  await rm(publicationTransactionRoot(recoveryRoot, recoveryId), { recursive: true, force: true });
}

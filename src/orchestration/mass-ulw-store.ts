import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MassUlwPlan } from "./mass-ulw.js";
import type { MassUlwCommittedPublicationReceipt } from "./mass-ulw-workspace.js";
import { CommittedPublicationReceiptSchema } from "./mass-ulw-publish-recovery.js";
import { MassUlwStoreFiles } from "./mass-ulw-store-files.js";
import { MassUlwDocumentSchema, PlanSchema } from "./mass-ulw-store-schema.js";
import type { MassUlwDocument, MassUlwStoreOptions } from "./mass-ulw-store-schema.js";

export { MassUlwDocumentSchema } from "./mass-ulw-store-schema.js";
export type { MassUlwAttempt, MassUlwDocument, MassUlwLaneState, MassUlwLoopLock, MassUlwPublishEntry, MassUlwStoreOptions, MassUlwWaveState } from "./mass-ulw-store-schema.js";

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export class MassUlwStore extends MassUlwStoreFiles {
  constructor(stateDir: string, options: MassUlwStoreOptions = {}) { super(stateDir, options); }
  async create(loopId: string, plan: MassUlwPlan): Promise<MassUlwDocument> {
    return this.withUpdateLock(loopId, async () => {
      const validatedPlan = PlanSchema.parse(plan);
      try {
        await readFile(this.documentPath(loopId), "utf8");
        throw new Error(`MASS ULW state already exists: ${loopId}`);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }

      const timestamp = this.now();
      const lanes = Object.fromEntries(validatedPlan.lanes.map((lane) => [
        lane.id,
        { lane, status: "planned" as const, attempts: 0 },
      ]));
      const document: MassUlwDocument = {
        version: 1,
        loopId,
        createdAt: timestamp,
        updatedAt: timestamp,
        plan: validatedPlan,
        waves: validatedPlan.waves.map((laneIds, index) => ({ index, laneIds, status: "planned" })),
        lanes,
        attempts: [],
        fingerprints: {
          plan: validatedPlan.planFingerprint,
          lanes: Object.fromEntries(validatedPlan.lanes.map((lane) => [lane.id, fingerprint(lane)])),
          integration: null,
          publish: null,
        },
        currentWave: validatedPlan.waves.length === 0 ? null : 0,
        integrationVerification: { status: "not-started" },
        publishJournal: [],
      };
      await this.persist(document);
      return MassUlwDocumentSchema.parse(document);
    });
  }

  async load(loopId: string): Promise<MassUlwDocument> {
    return this.readDocument(loopId);
  }

  async update(loopId: string, mutate: (document: MassUlwDocument) => void): Promise<MassUlwDocument> {
    return this.withUpdateLock(loopId, async () => {
      const document = await this.readDocument(loopId);
      mutate(document);
      document.updatedAt = this.now();
      const validated = MassUlwDocumentSchema.parse(document);
      await this.persist(validated);
      return validated;
    });
  }

  async remove(loopId: string): Promise<void> {
    await this.withUpdateLock(loopId, async () => {
      await this.removeDocument(loopId);
    });
  }

  async resume(loopId: string): Promise<MassUlwDocument> {
    return this.withUpdateLock(loopId, async () => {
      const document = await this.readDocument(loopId);
      const timestamp = this.now();
      const before = JSON.stringify(document);

      for (const attempt of document.attempts) {
        if (attempt.status === "in-flight") {
          attempt.status = "interrupted";
          attempt.completedAt = timestamp;
        }
      }
      for (const lane of Object.values(document.lanes)) {
        if (lane.status === "in-flight" || lane.status === "failed") {
          lane.status = "planned";
          delete lane.completedAt;
        }
      }
      for (const wave of document.waves) {
        const completed = wave.laneIds.every((laneId) => document.lanes[laneId]?.status === "completed");
        if (completed) {
          wave.status = "completed";
          wave.completedAt ??= timestamp;
        } else if (wave.laneIds.some((laneId) => document.lanes[laneId]?.status === "blocked")) {
          wave.status = "failed";
          delete wave.completedAt;
        } else {
          wave.status = "planned";
          delete wave.completedAt;
        }
      }
      document.currentWave = document.waves.find((wave) => wave.status !== "completed")?.index ?? null;
      if (document.integrationVerification.status === "in-flight") {
        document.integrationVerification = {
          status: "unknown-after-interruption",
          attemptId: document.integrationVerification.attemptId,
          fingerprint: document.integrationVerification.fingerprint,
          startedAt: document.integrationVerification.startedAt,
          interruptedAt: timestamp,
        };
      }
      for (const entry of document.publishJournal) {
        if (entry.status === "in-flight") {
          entry.status = "unknown-after-interruption";
          entry.completedAt = timestamp;
        }
      }

      if (JSON.stringify(document) !== before) {
        document.updatedAt = timestamp;
        const validated = MassUlwDocumentSchema.parse(document);
        await this.persist(validated);
        return validated;
      }
      return document;
    });
  }

  async claimIntegrationVerification(loopId: string, attemptId: string, fingerprintValue: string): Promise<boolean> {
    if (!attemptId || !fingerprintValue) throw new Error("Integration verification requires an attempt id and fingerprint");
    return this.withUpdateLock(loopId, async () => {
      const document = await this.readDocument(loopId);
      if (
        document.integrationVerification.status !== "not-started" ||
        document.attempts.some((attempt) => attempt.id === attemptId)
      ) {
        return false;
      }
      const timestamp = this.now();
      document.integrationVerification = {
        status: "in-flight",
        attemptId,
        fingerprint: fingerprintValue,
        startedAt: timestamp,
      };
      document.fingerprints.integration = fingerprintValue;
      document.attempts.push({
        id: attemptId,
        kind: "integration-verification",
        status: "in-flight",
        startedAt: timestamp,
        fingerprint: fingerprintValue,
      });
      document.updatedAt = timestamp;
      const validated = MassUlwDocumentSchema.parse(document);
      await this.persist(validated);
      return true;
    });
  }

  async reconcileCommittedPublication(loopId: string, receipt: MassUlwCommittedPublicationReceipt): Promise<MassUlwDocument> {
    return this.withUpdateLock(loopId, async () => {
      const document = await this.readDocument(loopId);
      if (
        document.integrationVerification.status !== "passed" ||
        document.integrationVerification.fingerprint !== receipt.integrationCommit ||
        document.fingerprints.publish !== receipt.publishFingerprint
      ) {
        throw new Error("Committed MASS ULW publication does not match the verified generation");
      }
      const validatedReceipt = CommittedPublicationReceiptSchema.parse(receipt);
      const publishedEntries = document.publishJournal.filter((entry) =>
        entry.fingerprint === receipt.publishFingerprint && entry.status === "published");
      const publishedEntry = publishedEntries.length === 1 ? publishedEntries[0] : undefined;
      const publishedAttempt = publishedEntry && document.attempts.find(
        (candidate) => candidate.id === publishedEntry.attemptId && candidate.kind === "publish",
      );
      if (publishedEntry?.receipt && publishedAttempt?.status === "completed" &&
        publishedAttempt.fingerprint === receipt.publishFingerprint &&
        fingerprint(publishedEntry.receipt) === fingerprint(validatedReceipt)) return document;
      const matches = document.publishJournal.filter((entry) =>
        entry.fingerprint === receipt.publishFingerprint &&
        (entry.status === "in-flight" || entry.status === "failed" || entry.status === "unknown-after-interruption"));
      const entry = matches.length === 1 ? matches[0] : undefined;
      const attempt = entry
        ? document.attempts.find((candidate) => candidate.id === entry.attemptId && candidate.kind === "publish")
        : undefined;
      if (
        !entry || !attempt || attempt.fingerprint !== receipt.publishFingerprint ||
        (attempt.status !== "in-flight" && attempt.status !== "failed" && attempt.status !== "interrupted")
      ) {
        throw new Error("Committed MASS ULW publication has no matching interrupted attempt");
      }
      const timestamp = this.now();
      entry.status = "published";
      entry.completedAt = timestamp;
      entry.receipt = validatedReceipt;
      attempt.status = "completed";
      attempt.completedAt = timestamp;
      document.updatedAt = timestamp;
      const validated = MassUlwDocumentSchema.parse(document);
      await this.persist(validated);
      return validated;
    });
  }

  async completeIntegrationVerification(
    loopId: string,
    attemptId: string,
    result: "passed" | "failed",
  ): Promise<MassUlwDocument> {
    return this.withUpdateLock(loopId, async () => {
      const document = await this.readDocument(loopId);
      const verification = document.integrationVerification;
      if (verification.status !== "in-flight" || verification.attemptId !== attemptId) {
        throw new Error(`Integration verification attempt is not in flight: ${attemptId}`);
      }
      const attempt = document.attempts.find((candidate) => candidate.id === attemptId);
      if (!attempt || attempt.kind !== "integration-verification" || attempt.status !== "in-flight") {
        throw new Error(`Integration verification attempt is invalid: ${attemptId}`);
      }
      const timestamp = this.now();
      document.integrationVerification = {
        status: result,
        attemptId,
        fingerprint: verification.fingerprint,
        startedAt: verification.startedAt,
        completedAt: timestamp,
      };
      attempt.status = result === "passed" ? "completed" : "failed";
      attempt.completedAt = timestamp;
      document.updatedAt = timestamp;
      const validated = MassUlwDocumentSchema.parse(document);
      await this.persist(validated);
      return validated;
    });
  }
}

import { join } from "node:path";
import type { MassUlwStore } from "./mass-ulw-store.js";
import type { MassUlwCommittedPublicationReceipt, MassUlwIntegrationResult, MassUlwPublishResult } from "./mass-ulw-workspace.js";
import type { MassUlwWorkspaceLike, VerificationEngine, VerificationResult } from "./mass-ulw-executor-types.js";
import { CommittedPublicationReceiptSchema, massUlwPublishFingerprint } from "./mass-ulw-publish-recovery.js";
function optionalFingerprint(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
export class MassUlwFinalizer { constructor(private readonly config: {
  store: MassUlwStore;
  verificationEngine: VerificationEngine;
  now: () => number;
  authorizeIntegratedVerification: () => Promise<void>;
  authorizePublish: () => Promise<void>;
}) {}
  async verifyIntegrated(
    loopId: string,
    workspace: MassUlwWorkspaceLike,
    integration: MassUlwIntegrationResult,
  ): Promise<{ passed: boolean; invocationCount: 0 | 1 }> {
    const document = await this.config.store.load(loopId);
    if (document.integrationVerification.status === "passed") {
      return {
        passed: document.integrationVerification.fingerprint === integration.commit,
        invocationCount: 1,
      };
    }
    if (document.integrationVerification.status !== "not-started") return { passed: false, invocationCount: 0 };

    await this.config.authorizeIntegratedVerification();
    const attemptId = `${loopId}:integration-verification:1`;
    const claimed = await this.config.store.claimIntegrationVerification(loopId, attemptId, integration.commit);
    if (!claimed) return { passed: false, invocationCount: 0 };
    let result: VerificationResult;
    try {
      result = await this.config.verificationEngine.verifyIntegrated({
        loopId,
        root: join(workspace.privateRoot, "merged"),
        fingerprint: integration.commit,
        changedPaths: [...integration.changedPaths],
        invocationCount: 1,
      });
    } catch (error) {
      await this.config.store.completeIntegrationVerification(loopId, attemptId, "failed");
      throw error;
    }
    const passed = result.passed && optionalFingerprint(result.fingerprint) !== undefined;
    await this.config.store.completeIntegrationVerification(loopId, attemptId, passed ? "passed" : "failed");
    return { passed, invocationCount: 1 };
  }

  async reconcilePublished(loopId: string, receipt: MassUlwCommittedPublicationReceipt): Promise<void> {
    await this.config.store.reconcileCommittedPublication(loopId, receipt);
  }

  async publish(
    loopId: string,
    workspace: MassUlwWorkspaceLike,
    integration: MassUlwIntegrationResult,
  ): Promise<MassUlwPublishResult> {
    await this.config.authorizePublish();
    const publishFingerprint = massUlwPublishFingerprint(integration.commit, integration.changedPaths);
    const document = await this.config.store.load(loopId);
    const ordinal = document.publishJournal.length + 1;
    const attemptId = `${loopId}:publish:${ordinal}`;
    const journalId = `publish-${ordinal}`;
    await this.config.store.update(loopId, (current) => {
      const timestamp = this.config.now();
      current.fingerprints.publish = publishFingerprint;
      current.attempts.push({
        id: attemptId,
        kind: "publish",
        status: "in-flight",
        startedAt: timestamp,
        fingerprint: publishFingerprint,
      });
      current.publishJournal.push({
        id: journalId,
        fingerprint: publishFingerprint,
        status: "in-flight",
        attemptId,
        startedAt: timestamp,
      });
    });
    try {
      const result = await workspace.publish();
      await this.config.store.update(loopId, (current) => {
        const timestamp = this.config.now();
        const attempt = current.attempts.find((candidate) => candidate.id === attemptId)!;
        const journal = current.publishJournal.find((entry) => entry.id === journalId)!;
        attempt.status = "completed";
        attempt.completedAt = timestamp;
        journal.status = "published";
        journal.completedAt = timestamp;
        if (result.receipt) journal.receipt = CommittedPublicationReceiptSchema.parse(result.receipt);
      });
      return result;
    } catch (error) {
      await this.config.store.update(loopId, (current) => {
        const timestamp = this.config.now();
        const attempt = current.attempts.find((candidate) => candidate.id === attemptId)!;
        const journal = current.publishJournal.find((entry) => entry.id === journalId)!;
        attempt.status = "failed";
        attempt.completedAt = timestamp;
        journal.status = "failed";
        journal.completedAt = timestamp;
      });
      throw error;
    }
  }
}

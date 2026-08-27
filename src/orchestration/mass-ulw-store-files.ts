import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireMassUlwLock } from "./mass-ulw-lock.js";
import { DIRECTORY_MODE, FILE_MODE, LOOP_ID_PATTERN, MassUlwDocumentSchema } from "./mass-ulw-store-schema.js";
import type { MassUlwDocument, MassUlwLoopLock, MassUlwStoreOptions } from "./mass-ulw-store-schema.js";

const updateQueues = new Map<string, Promise<void>>();

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = updateQueues.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.then(() => undefined, () => undefined);
  updateQueues.set(key, tail);
  void tail.then(() => {
    if (updateQueues.get(key) === tail) updateQueues.delete(key);
  });
  return run;
}

export class MassUlwStoreFiles {
  protected readonly directory: string;
  protected readonly queueDirectory: string;
  protected readonly now: () => number;
  private readonly onStaleLockObserved?: () => void | Promise<void>;

  constructor(stateDir: string, options: MassUlwStoreOptions = {}) {
    this.directory = join(stateDir, "orchestration", "mass-ulw");
    this.queueDirectory = resolve(this.directory);
    this.now = options.now ?? Date.now;
    this.onStaleLockObserved = options.onStaleLockObserved;
  }

  protected validateLoopId(loopId: string): void {
    if (!LOOP_ID_PATTERN.test(loopId)) throw new Error("Invalid MASS ULW loop id");
  }

  protected documentPath(loopId: string): string {
    this.validateLoopId(loopId);
    return join(this.directory, `${loopId}.json`);
  }

  protected lockPath(loopId: string): string {
    this.validateLoopId(loopId);
    return join(this.directory, `${loopId}.lock`);
  }

  protected async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(this.directory, DIRECTORY_MODE);
  }

  protected async readDocument(loopId: string): Promise<MassUlwDocument> {
    const path = this.documentPath(loopId);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new Error(`MASS ULW state does not exist: ${loopId}`);
      throw new Error(`MASS ULW state could not be read: ${(error as Error).message}`);
    }
    const parsed = MassUlwDocumentSchema.safeParse(value);
    if (!parsed.success) throw new Error(`MASS ULW state failed validation: ${parsed.error.message}`);
    if (parsed.data.loopId !== loopId) throw new Error("MASS ULW state failed validation: loop id does not match its filename");
    return parsed.data;
  }

  protected async persist(document: MassUlwDocument): Promise<void> {
    const validated = MassUlwDocumentSchema.parse(document);
    await this.ensureDirectory();
    const target = this.documentPath(validated.loopId);
    const temporary = join(this.directory, `.${validated.loopId}.${process.pid}.${randomUUID()}.tmp`);
    let renamed = false;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", FILE_MODE);
      await handle.writeFile(JSON.stringify(validated, null, 2), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, FILE_MODE);
      await rename(temporary, target);
      renamed = true;
      await chmod(target, FILE_MODE);
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }

  protected async removeDocument(loopId: string): Promise<void> {
    try {
      await unlink(this.documentPath(loopId));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  async acquireLock(loopId: string): Promise<MassUlwLoopLock> {
    this.validateLoopId(loopId);
    await this.ensureDirectory();
    return acquireMassUlwLock({
      path: this.lockPath(loopId),
      now: this.now,
      lockedMessage: `MASS ULW loop is already locked: ${loopId}`,
      ...(this.onStaleLockObserved === undefined
        ? {}
        : { onAbandonedObserved: this.onStaleLockObserved }),
    });
  }

  protected withUpdateLock<T>(loopId: string, operation: () => Promise<T>): Promise<T> {
    this.validateLoopId(loopId);
    const key = `${this.queueDirectory}\0${loopId}`;
    return serialized(key, async () => {
      const lock = await this.acquireLock(loopId);
      try {
        return await operation();
      } finally {
        await lock.release();
      }
    });
  }

}

import { lstat, mkdir, readFile, rm, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicCreate, atomicWrite, atomicWriteGuarded } from "./fs.js";
import { hashContent } from "./hash.js";
import { PoiesisError } from "./errors.js";
import { ownershipReceiptLocation } from "./receipt.js";

export type ArtifactOwnershipMode = "whole-file" | "patch";

export interface ArtifactIdentity {
  exists: boolean;
  kind: "absent" | "file" | "other";
  hash?: string;
}

export interface ArtifactJournalEntry {
  path: string;
  physicalExists: boolean;
  preimage?: Buffer;
  physicalMode?: number;
  ownershipMode: ArtifactOwnershipMode;
  expectedPreWriteIdentity: ArtifactIdentity;
  transactionWrittenIdentity?: ArtifactIdentity;
}

export interface RollbackDiagnostic {
  path: string;
  reason: "identity-mismatch" | "restore-failed";
  expected?: ArtifactIdentity;
  actual?: ArtifactIdentity;
  error?: string;
}

async function identity(path: string): Promise<ArtifactIdentity> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return { exists: true, kind: "other" };
    return { exists: true, kind: "file", hash: hashContent(await readFile(path)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, kind: "absent" };
    throw error;
  }
}

function identitiesEqual(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return left.exists === right.exists && left.kind === right.kind && left.hash === right.hash;
}

/** A command-local, bounded journal. It deliberately has no persisted workflow state. */
export class ArtifactJournal {
  readonly entries: ArtifactJournalEntry[] = [];

  constructor(private readonly limit: number) {}

  async capture(path: string, ownershipMode: ArtifactOwnershipMode): Promise<ArtifactJournalEntry> {
    if (this.entries.length >= this.limit) {
      throw new PoiesisError("TRANSACTION_JOURNAL_LIMIT", "Mutation journal artifact limit exceeded", { limit: this.limit });
    }
    if (this.entries.some((entry) => entry.path === path)) {
      throw new PoiesisError("TRANSACTION_JOURNAL_DUPLICATE", "Mutation journal already contains artifact", { path });
    }
    let preimage: Buffer | undefined;
    let physicalMode: number | undefined;
    let expectedPreWriteIdentity: ArtifactIdentity;
    try {
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new PoiesisError("ARTIFACT_IDENTITY_INVALID", "Transaction artifact is not a regular file", { path });
      } else {
        preimage = await readFile(path);
        physicalMode = stats.mode & 0o7777;
        expectedPreWriteIdentity = { exists: true, kind: "file", hash: hashContent(preimage) };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      expectedPreWriteIdentity = { exists: false, kind: "absent" };
    }
    const entry: ArtifactJournalEntry = {
      path,
      physicalExists: expectedPreWriteIdentity.exists,
      ...(preimage === undefined ? {} : { preimage }),
      ...(physicalMode === undefined ? {} : { physicalMode }),
      ownershipMode,
      expectedPreWriteIdentity,
    };
    this.entries.push(entry);
    return entry;
  }

  async replace(entry: ArtifactJournalEntry, content: string | Buffer): Promise<void> {
    await atomicWriteGuarded(entry.path, content, async () => {
      const actual = await identity(entry.path);
      if (!identitiesEqual(actual, entry.expectedPreWriteIdentity)) {
        throw new PoiesisError("ARTIFACT_IDENTITY_DRIFT", "Artifact changed immediately before replacement", {
          path: entry.path,
          expected: entry.expectedPreWriteIdentity,
          actual,
        });
      }
    });
    entry.transactionWrittenIdentity = { exists: true, kind: "file", hash: hashContent(content) };
  }

  async rollback(): Promise<RollbackDiagnostic[]> {
    const diagnostics: RollbackDiagnostic[] = [];
    for (const entry of [...this.entries].reverse()) {
      const expected = entry.transactionWrittenIdentity;
      if (expected === undefined) continue;
      let actual: ArtifactIdentity;
      try {
        actual = await identity(entry.path);
      } catch (error) {
        diagnostics.push({ path: entry.path, reason: "restore-failed", expected, error: String(error) });
        continue;
      }
      if (!identitiesEqual(actual, expected)) {
        diagnostics.push({ path: entry.path, reason: "identity-mismatch", expected, actual });
        continue;
      }
      try {
        if (entry.physicalExists) {
          await atomicWrite(entry.path, entry.preimage!);
          if (entry.physicalMode !== undefined) await chmod(entry.path, entry.physicalMode);
        } else {
          await rm(entry.path);
        }
      } catch (error) {
        diagnostics.push({ path: entry.path, reason: "restore-failed", expected, actual, error: String(error) });
      }
    }
    return diagnostics;
  }
}

export interface WorkspaceMutationLock {
  path: string;
  release(): Promise<void>;
}

/** Acquire one fail-fast, cooperating mutation lock for the canonical workspace receipt key. */
export async function acquireWorkspaceMutationLock(root: string): Promise<WorkspaceMutationLock> {
  const receiptPath = await ownershipReceiptLocation(root);
  const path = `${receiptPath}.mutation.lock`;
  const token = `${process.pid}:${randomUUID()}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await atomicCreate(path, token);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new PoiesisError("POIESIS_MUTATION_LOCKED", "Another Poiesis mutation is active for this workspace", { path });
    }
    throw error;
  }
  let released = false;
  return {
    path,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        const current = await readFile(path, "utf8");
        if (current !== token) {
          throw new PoiesisError("POIESIS_MUTATION_LOCK_LOST", "Poiesis mutation lock identity changed", { path });
        }
        await rm(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new PoiesisError("POIESIS_MUTATION_LOCK_LOST", "Poiesis mutation lock disappeared", { path });
        }
        throw error;
      }
    },
  };
}

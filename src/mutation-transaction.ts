import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { atomicCreate, atomicWrite, atomicWriteGuarded } from "./fs.js";
import { hashContent } from "./hash.js";
import { PoiesisError } from "./errors.js";
import { ownershipReceiptLocation } from "./receipt.js";

export type ArtifactOwnershipMode = "whole-file" | "patch" | "directory";

export interface ArtifactIdentity {
  exists: boolean;
  kind: "absent" | "file" | "directory" | "other";
  hash?: string;
}

export interface ArtifactJournalEntry {
  path: string;
  physicalExists: boolean;
  preimage?: Buffer;
  /**
   * Journal-owned preimage backup location for `directory`-mode entries.
   * Created inside an isolated mkdtemp directory by `captureDirectory`
   * and removed by `commit` or `rollback`. Tickets #46 + #30: the
   * bounded journal is the single source of truth for the preimage so
   * rollback restores the EXACT preimage bytes and backup cleanup is
   * gated on commit/rollback (not the caller's `finally`).
   */
  preimageBackup?: string;
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
    if (stats.isSymbolicLink()) return { exists: true, kind: "other" };
    if (stats.isDirectory()) {
      return { exists: true, kind: "directory", hash: await hashDirectoryTree(path) };
    }
    if (stats.isFile()) {
      return { exists: true, kind: "file", hash: hashContent(await readFile(path)) };
    }
    return { exists: true, kind: "other" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, kind: "absent" };
    throw error;
  }
}

/**
 * Deterministic, hash-of-paths-and-bytes for an owned directory tree.
 * Lives here so the bounded journal does not depend on the skills module
 * (avoiding a circular import). Symlinks, sockets, and other non-file/non-directory
 * entries fail closed; the bounded journal is exclusively for owned regular
 * directory trees.
 */
export async function hashDirectoryTree(path: string): Promise<string> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new PoiesisError("ARTIFACT_IDENTITY_INVALID", "Transaction artifact is not a real directory", { path });
  }
  const hash = createHash("sha256");
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = `${directory}/${entry.name}`;
      const childPath = child.slice(path.length + 1);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new PoiesisError("ARTIFACT_IDENTITY_INVALID", "Transaction directory contains non-regular entries", { path: child });
      }
      if (entry.isDirectory()) {
        hash.update(`directory\0${childPath}\0`);
        await walk(child);
      } else {
        hash.update(`file\0${childPath}\0`);
        hash.update(await readFile(child));
        hash.update("\0");
      }
    }
  }
  await walk(path);
  return hash.digest("hex");
}

function identitiesEqual(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return left.exists === right.exists && left.kind === right.kind && left.hash === right.hash;
}

/** A command-local, bounded journal. It deliberately has no persisted workflow state. */
export class ArtifactJournal {
  readonly entries: ArtifactJournalEntry[] = [];
  private backupRoot: string | undefined;

  constructor(private readonly limit: number) {}

  private async ensureBackupRoot(): Promise<string> {
    if (this.backupRoot !== undefined) return this.backupRoot;
    const root = await mkdtemp(`${tmpdir()}/poiesis-journal-`);
    this.backupRoot = root;
    return root;
  }

  async capture(path: string, ownershipMode: ArtifactOwnershipMode): Promise<ArtifactJournalEntry> {
    if (this.entries.length >= this.limit) {
      throw new PoiesisError("TRANSACTION_JOURNAL_LIMIT", "Mutation journal artifact limit exceeded", { limit: this.limit });
    }
    if (this.entries.some((entry) => entry.path === path)) {
      throw new PoiesisError("TRANSACTION_JOURNAL_DUPLICATE", "Mutation journal already contains artifact", { path });
    }
    if (ownershipMode === "directory") {
      throw new PoiesisError("ARTIFACT_JOURNAL_MODE_INVALID", "Use captureDirectory for directory-mode entries", { path });
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

  /**
   * Capture a `directory`-mode entry into the bounded journal. Creates
   * an isolated journal-owned preimage backup (recursively copies the
   * directory if it exists). The journal owns the backup lifecycle:
   * `commit` removes it after a successful transaction; `rollback`
   * restores from it (when the on-disk tree still matches the
   * transaction-written identity) and then removes it.
   *
   * The capture snapshot is the EXACT preimage hash of the on-disk tree
   * at this moment. The rollback path hash-gates against
   * `transactionWrittenIdentity` (recorded by `recordDirectoryWrite`)
   * and never against `expectedPreWriteIdentity`, so a foreign writer
   * that lands between capture and write does not contaminate the
   * rollback identity. Ticket #46.
   */
  async captureDirectory(path: string): Promise<ArtifactJournalEntry> {
    if (this.entries.length >= this.limit) {
      throw new PoiesisError("TRANSACTION_JOURNAL_LIMIT", "Mutation journal artifact limit exceeded", { limit: this.limit });
    }
    if (this.entries.some((entry) => entry.path === path)) {
      throw new PoiesisError("TRANSACTION_JOURNAL_DUPLICATE", "Mutation journal already contains artifact", { path });
    }
    let physicalExists = false;
    let preimageHash: string | undefined;
    const backupRoot = await this.ensureBackupRoot();
    const backupPath = `${backupRoot}/${randomUUID()}`;
    try {
      const stats = await lstat(path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new PoiesisError("ARTIFACT_IDENTITY_INVALID", "Transaction artifact is not a real directory", { path });
      }
      physicalExists = true;
      preimageHash = await hashDirectoryTree(path);
      try {
        await cp(path, backupPath, { recursive: true, errorOnExist: true, force: false });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ERR_FS_CP_EEXIST" || code === "EEXIST") {
          throw new PoiesisError("ARTIFACT_JOURNAL_BACKUP_CONFLICT", "Preimage backup path already exists", { path: backupPath });
        }
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      physicalExists = false;
    }
    const expectedPreWriteIdentity: ArtifactIdentity = physicalExists
      ? (preimageHash === undefined
          ? { exists: true, kind: "directory" }
          : { exists: true, kind: "directory", hash: preimageHash })
      : { exists: false, kind: "absent" };
    const entry: ArtifactJournalEntry = {
      path,
      physicalExists,
      preimageBackup: backupPath,
      ownershipMode: "directory",
      expectedPreWriteIdentity,
    };
    this.entries.push(entry);
    return entry;
  }

  async replace(entry: ArtifactJournalEntry, content: string | Buffer): Promise<void> {
    if (entry.ownershipMode === "directory") {
      throw new PoiesisError("ARTIFACT_JOURNAL_MODE_INVALID", "Use recordDirectoryWrite for directory-mode entries", { path: entry.path });
    }
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

  /**
   * Record the transaction-written identity for a `directory`-mode entry
   * after the caller has written the directory at `entry.path`. The
   * journal hash-gates the rollback against this identity so a
   * concurrent foreign writer that lands between the write and the
   * rollback is preserved and reported (via
   * `RollbackDiagnostic` reason `identity-mismatch`). Ticket #46.
   */
  async recordDirectoryWrite(entry: ArtifactJournalEntry, writtenHash: string): Promise<void> {
    if (entry.ownershipMode !== "directory") {
      throw new PoiesisError("ARTIFACT_JOURNAL_MODE_INVALID", "Journal entry is not a directory-mode entry", { path: entry.path });
    }
    entry.transactionWrittenIdentity = { exists: true, kind: "directory", hash: writtenHash };
  }

  /**
   * Commit the journal after a successful transaction. Removes every
   * journal-owned directory backup the journal created during
   * `captureDirectory`. Failures are swallowed (`catch(() => undefined)`)
   * so a cleanup failure cannot turn a committed transaction into a
   * failure. Ticket #46: "backup cleanup only after commit/rollback and
   * cannot turn committed update into failure".
   */
  async commit(): Promise<void> {
    for (const entry of this.entries) {
      if (entry.ownershipMode !== "directory") continue;
      if (entry.preimageBackup === undefined) continue;
      await rm(entry.preimageBackup, { recursive: true, force: true }).catch(() => undefined);
    }
    if (this.backupRoot !== undefined) {
      await rm(this.backupRoot, { recursive: true, force: true }).catch(() => undefined);
      this.backupRoot = undefined;
    }
  }

  async rollback(): Promise<RollbackDiagnostic[]> {
    const diagnostics: RollbackDiagnostic[] = [];
    for (const entry of [...this.entries].reverse()) {
      if (entry.ownershipMode === "directory") {
        await this.rollbackDirectory(entry, diagnostics);
        continue;
      }
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

  private async rollbackDirectory(entry: ArtifactJournalEntry, diagnostics: RollbackDiagnostic[]): Promise<void> {
    const expected = entry.transactionWrittenIdentity;
    if (expected === undefined) return;
    let actual: ArtifactIdentity;
    try {
      actual = await identity(entry.path);
    } catch (error) {
      diagnostics.push({ path: entry.path, reason: "restore-failed", expected, error: String(error) });
      await this.cleanupBackup(entry);
      return;
    }
    if (!identitiesEqual(actual, expected)) {
      diagnostics.push({ path: entry.path, reason: "identity-mismatch", expected, actual });
      // Preserve the foreign write on disk; the journal only restores
      // the preimage when the on-disk tree still matches the
      // transaction-written identity.
      await this.cleanupBackup(entry);
      return;
    }
    try {
      if (entry.physicalExists) {
        if (entry.preimageBackup === undefined) {
          diagnostics.push({ path: entry.path, reason: "restore-failed", expected, actual, error: "preimage backup missing" });
          return;
        }
        // The transaction-owned directory still matches the journal's
        // transaction-written identity, so the foreign-write window is
        // closed: rename the preimage backup back to the destination.
        // This atomically overwrites the transaction-authored tree and
        // is the byte-for-byte preimage restored by the journal.
        await rm(entry.path, { recursive: true, force: true });
        await rename(entry.preimageBackup, entry.path);
      } else {
        // The destination did not exist before the transaction. Roll
        // back by removing the transaction-authored directory.
        await rm(entry.path, { recursive: true, force: true });
      }
    } catch (error) {
      diagnostics.push({ path: entry.path, reason: "restore-failed", expected, actual, error: String(error) });
    }
    await this.cleanupBackup(entry);
  }

  private async cleanupBackup(entry: ArtifactJournalEntry): Promise<void> {
    if (entry.preimageBackup === undefined) return;
    await rm(entry.preimageBackup, { recursive: true, force: true }).catch(() => undefined);
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
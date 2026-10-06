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
  /**
   * Spec #168 / ticket #178 — where the preimage still exists when the
   * destination could not be restored.
   *
   * A restoration that fails leaves its preimage where an operator can recover
   * it, and this names that location. It is never a path the journal then
   * removes: deleting the only remaining copy would turn a reported
   * incomplete rollback into unrecoverable data loss.
   */
  preimageRecoveredAt?: string;
}

/**
 * Spec #168 / ticket #178 — the seams the directory-mode restoration reads the
 * host through.
 *
 * `moveRestorationCandidate` defaults to `rename`. It exists because the failure
 * this redesign exists to survive is a DEVICE failure, and a test machine whose
 * `os.tmpdir()` shares the workspace's filesystem would never produce one. The
 * seam changes WHAT the restore calls, never WHAT it accepts: the production
 * default is the real `rename`, and an injected `EXDEV` only makes the
 * same-device guarantee fail the way a real cross-device host does.
 */
export interface ArtifactJournalOptions {
  moveRestorationCandidate?: (from: string, to: string) => Promise<void>;
}

/** Prefix of the transient, Poiesis-owned directory a preimage is staged into. */
const RESTORE_STAGING_PREFIX = ".poiesis-restore-";

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
  private readonly options: ArtifactJournalOptions;

  constructor(
    private readonly limit: number,
    options: ArtifactJournalOptions = {},
  ) {
    this.options = options;
  }

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
    if (!entry.physicalExists) {
      // The destination did not exist before the transaction. Roll
      // back by removing the transaction-authored directory.
      try {
        await rm(entry.path, { recursive: true, force: true });
      } catch (error) {
        diagnostics.push({ path: entry.path, reason: "restore-failed", expected, actual, error: String(error) });
      }
      await this.cleanupBackup(entry);
      return;
    }
    if (entry.preimageBackup === undefined) {
      diagnostics.push({ path: entry.path, reason: "restore-failed", expected, actual, error: "preimage backup missing" });
      return;
    }
    // Spec #168 / ticket #178: the preimage is COPIED onto the destination's
    // own filesystem FIRST. The journal's backup lives under `os.tmpdir()`,
    // which is routinely a different device from the workspace it protects, so
    // the `rename(backup -> destination)` this path used to perform could fail
    // `EXDEV` — after the transaction-written destination had already been
    // removed — and the backup was then cleaned up as though the restoration
    // had worked. That destroyed the only copy of the preimage while the run
    // merely reported an incomplete rollback.
    //
    // Copying first removes the device dependency from the move that matters:
    // `cp` reads across devices by definition, and the staged candidate then
    // shares a filesystem with the destination. Nothing is removed until that
    // candidate exists, and the backup survives every step that follows, so a
    // failure can only ever leave a recoverable copy behind — never none.
    let staged: string;
    try {
      staged = await this.stageRestorationCandidate(entry);
    } catch (error) {
      // The destination is untouched at this point, and the backup is retained:
      // a failed restoration must cost the operator nothing.
      diagnostics.push({
        path: entry.path,
        reason: "restore-failed",
        expected,
        actual,
        error: `the preimage could not be staged on the destination filesystem: ${String(error)}`,
        preimageRecoveredAt: entry.preimageBackup,
      });
      return;
    }
    try {
      await rm(entry.path, { recursive: true, force: true });
      await (this.options.moveRestorationCandidate ?? rename)(staged, entry.path);
    } catch (error) {
      // Either the destination could not be removed or the same-device move
      // failed. The staged candidate still holds the preimage and is named, so
      // the operator can recover it; the backup is retained alongside it.
      diagnostics.push({
        path: entry.path,
        reason: "restore-failed",
        expected,
        actual,
        error: String(error),
        preimageRecoveredAt: staged,
      });
      return;
    }
    // The preimage is back in place, so the backup has done its job.
    await this.cleanupBackup(entry);
  }

  /**
   * Spec #168 / ticket #178 — put a byte-for-byte copy of the preimage on the
   * DESTINATION's own filesystem, and prove it is that preimage.
   *
   * The same identity and symlink safety the journal already applies to the
   * destination is applied to the candidate before anything is removed: it must
   * be a real directory (never a symlink or a device) and, whenever the capture
   * recorded a preimage hash, it must hash to exactly that. A candidate that
   * fails either check is removed immediately and the caller keeps the backup —
   * so a wrong or unsafe candidate can never become the restored tree.
   */
  private async stageRestorationCandidate(entry: ArtifactJournalEntry): Promise<string> {
    const backup = entry.preimageBackup;
    if (backup === undefined) {
      throw new PoiesisError("ARTIFACT_JOURNAL_BACKUP_MISSING", "Directory rollback has no preimage backup", {
        path: entry.path,
      });
    }
    const staged = `${dirname(entry.path)}/${RESTORE_STAGING_PREFIX}${randomUUID()}`;
    try {
      await cp(backup, staged, { recursive: true, errorOnExist: true, force: false });
    } catch (error) {
      await rm(staged, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    try {
      const stats = await lstat(staged);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new PoiesisError("ARTIFACT_IDENTITY_INVALID", "Staged restoration candidate is not a real directory", {
          path: staged,
        });
      }
      const stagedIdentity: ArtifactIdentity = {
        exists: true,
        kind: "directory",
        hash: await hashDirectoryTree(staged),
      };
      if (
        entry.expectedPreWriteIdentity.hash !== undefined &&
        stagedIdentity.hash !== entry.expectedPreWriteIdentity.hash
      ) {
        throw new PoiesisError("ARTIFACT_IDENTITY_DRIFT", "Staged restoration candidate is not the captured preimage", {
          path: staged,
          expected: entry.expectedPreWriteIdentity,
          actual: stagedIdentity,
        });
      }
      return staged;
    } catch (error) {
      await rm(staged, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Remove a backup whose preimage no longer needs protecting: the transaction
   * committed, the destination did not exist before it, or the journal declined
   * to overwrite a foreign write.
   *
   * Spec #168 / ticket #178: this is deliberately NOT reached from a
   * restoration that failed. A backup is the only copy of a preimage that
   * failed to come back, so it is retained and named in the diagnostic
   * instead — a rollback that cannot restore must not also delete.
   */
  private async cleanupBackup(entry: ArtifactJournalEntry): Promise<void> {
    if (entry.preimageBackup === undefined) return;
    await rm(entry.preimageBackup, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface WorkspaceMutationLock {
  path: string;
  release(): Promise<void>;
}

/** Spec #168 / ticket #174 — what the lock file says about its holder. */
interface MutationLockHolder extends Record<string, unknown> {
  /** The pid recorded in the lock token, or `null` when it cannot be attributed. */
  holderPid: number | null;
  /** `true` / `false` when the holder is attributable, `null` when it is not. */
  holderRunning: boolean | null;
  /** Stable machine-readable classification of the blocked state. */
  hint: "live-mutation-lock" | "stale-mutation-lock" | "unattributable-mutation-lock";
  /** The one recovery that is correct for this exact state. */
  recovery: string;
}

/**
 * `process.kill(pid, 0)` is the only portable liveness probe available here,
 * and it is a probe, not a claim of identity: it answers "does a process with
 * this pid exist right now", never "is it still the Poiesis session that wrote
 * the lock". The diagnostic therefore reports liveness as evidence and never
 * lets it decide anything on its own.
 *
 * `EPERM` means the process exists but is owned by another user, which still
 * answers `true`. Every other error (notably `ESRCH`) means it is gone.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Spec #168 / ticket #174 — turn a held lock into an ACTIONABLE refusal.
 *
 * A lock survives its holder: when a Poiesis session dies without releasing
 * it, the next mutation finds a file whose owner is gone. Reporting only the
 * path leaves the operator unable to answer the two questions that matter
 * ("is something actually running?" and "what do I do now?"), and the
 * tempting wrong answer — deleting the lock — is precisely the bypass this
 * path must never take, because a LIVE concurrent mutation would be stolen.
 *
 * So the refusal names the holder, states whether it is still running, and
 * gives the one recovery valid for that state:
 *
 *   - live holder → wait for it, then re-run. Never remove a live lock.
 *   - stale holder → confirm no Poiesis mutation is running, then remove this
 *     one file and re-run. Never reclaimed automatically.
 *   - unattributable holder → the bytes are not a Poiesis lock token, so
 *     Poiesis refuses to guess who owns them; inspect the file, then remove it
 *     and re-run.
 *
 * Every branch still refuses. Nothing here writes, removes, or rewrites the
 * lock, and the caller still gets the same `POIESIS_MUTATION_LOCKED` code it
 * has always handled.
 */
async function describeMutationLockHolder(path: string): Promise<MutationLockHolder> {
  let token: string;
  try {
    token = await readFile(path, "utf8");
  } catch {
    // The holder released between our create attempt and this read. The
    // mutation is still refused — a lock this race-y is not one Poiesis may
    // assume it owns — but the operator is told the state is unattributable.
    return {
      path,
      holderPid: null,
      holderRunning: null,
      hint: "unattributable-mutation-lock",
      recovery: `Another Poiesis mutation may be finishing for this workspace. Re-run the same command; if it keeps failing, confirm no Poiesis mutation is running, then remove ${path} and re-run.`,
    };
  }
  // The token is exactly `<pid>:<uuid>\n`. A positive-integer pid is required,
  // not cosmetic: `process.kill(0, 0)` addresses a whole process group, so a
  // `0` pid would probe something other than a single holder. Anything that is
  // not a well-formed token — including a pid Poiesis would refuse to probe —
  // is unattributable, which is the fail-closed answer.
  const match = /^([1-9][0-9]*):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n?$/.exec(token);
  if (match === null) {
    return {
      path,
      holderPid: null,
      holderRunning: null,
      hint: "unattributable-mutation-lock",
      recovery: `${path} is held by bytes that are not a Poiesis mutation lock, so Poiesis cannot tell who owns them. Inspect the file, then remove ${path} and re-run the same command.`,
    };
  }
  const holderPid = Number.parseInt(match[1]!, 10);
  if (isProcessAlive(holderPid)) {
    return {
      path,
      holderPid,
      holderRunning: true,
      hint: "live-mutation-lock",
      recovery: `A Poiesis mutation is running for this workspace (pid ${holderPid}). Wait for it to finish, then re-run the same command. Do NOT remove ${path}: the running mutation still owns it.`,
    };
  }
  return {
    path,
    holderPid,
    holderRunning: false,
    hint: "stale-mutation-lock",
    recovery: `${path} is a stale lock: the Poiesis mutation that wrote it (pid ${holderPid}) is no longer running. Poiesis will not reclaim it automatically. Confirm no Poiesis mutation is running, then remove ${path} and re-run the same command.`,
  };
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
      const holder = await describeMutationLockHolder(path);
      throw new PoiesisError("POIESIS_MUTATION_LOCKED", "Another Poiesis mutation is active for this workspace", holder);
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
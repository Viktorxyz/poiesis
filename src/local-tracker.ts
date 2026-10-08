import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PoiesisError, invariant } from "./errors.js";
import { discoverGitCommonDir } from "./git-common-dir.js";
import type {
  CreateSpecInput,
  CreateTicketInput,
  SupersedeInput,
  TrackerAdapter,
  TrackerComment,
  TrackerItem,
  TrackerItemKind,
  UpdateTicketInput,
  UpdateTrackerItemInput,
} from "./adapters.js";

/**
 * Spec #139 / ticket #142 — the first-class `local` tracker.
 *
 * `local` is a COMPLETE `TrackerAdapter`: a real tracker with a durable store,
 * not a fixture, not an in-memory shim, and not a routing of local work
 * through the Git host CLI. Four properties are load-bearing and each is
 * enforced here rather than documented and hoped for.
 *
 *   1. CANONICAL LOCATION. The store lives in the Git COMMON directory
 *      (`<git-common-dir>/poiesis-tracker-v1`), which Git shares by every
 *      linked worktree and which `poiesis uninstall` never removes (it only
 *      removes working-tree and per-worktree artifacts). A linked worktree
 *      therefore observes exactly the Specs, Tickets, comments, and history
 *      its primary checkout recorded, and the adapter NEVER writes a byte
 *      inside a working tree. The directory name is versioned so a future
 *      store shape lands beside this one instead of corrupting it.
 *
 *   2. DURABILITY + MONOTONIC IDENTIFIERS. Identifiers are `LOCAL-<n>` from
 *      a counter that only ever increases; a number is never reused, even
 *      after every item has been closed or superseded. Every mutation is
 *      written as fsync'd temporary bytes -> atomic `rename` -> fsync of the
 *      containing directory, so a reader never observes a partial document and
 *      a crash never loses a committed comment or history entry.
 *
 *   3. EXCLUSIVITY ACROSS PROCESSES. Every read-modify-write runs under a
 *      cross-process lock (`store.lock` serialized by `store.lock.guard`).
 *      Release is token-checked, so a process can only ever remove ITS OWN
 *      lock. The two artifacts recover on DIFFERENT terms, and collapsing them
 *      would be a lie: a canonical `store.lock` whose holder PID is dead is
 *      reclaimed within the caller's bounded wait, a LIVE foreign lock is never
 *      stolen, and a malformed lock is never reclaimed — but the
 *      `store.lock.guard` is NEVER reclaimed by the runtime at any age. A guard
 *      only proves that some process was inside the read-decide-write critical
 *      section, and a dead stamped PID cannot distinguish a crashed holder from
 *      a live one this process is merely not permitted to signal, so clearing it
 *      is an operator decision that `LOCAL_TRACKER_LOCK_TIMEOUT` states in full
 *      (Spec #139 / ticket #148).
 *
 *   4. FAIL-CLOSED VALIDATION. The store document is validated strictly —
 *      unknown schema, forged identifier, non-monotonic counter, missing
 *      dependency text, dangling comment — is a typed refusal that leaves the
 *      bytes on disk untouched. A store, lock, or store directory that is a
 *      symlink or a nonregular file is refused before it is read or written,
 *      and every store file is 0600. Every operator-facing refusal carries the
 *      EXACT paths and the exact numbers as structured VALUES and states its
 *      procedure as PROSE, because a path is not a command and this store lives
 *      inside a Git common directory whose name Poiesis did not choose
 *      (Spec #139 / ticket #148, #155).
 *
 *   5. A BOUNDED COMPLETE SNAPSHOT. The document is the WHOLE history, so it
 *      only ever grows, which makes an unbounded read of it a memory cost
 *      charged to a caller who asked to read one item and an unbounded write a
 *      way to commit a store nothing can read back. ONE ceiling bounds the
 *      total serialized bytes, and ONE bounded loader serves all three
 *      consumers of the canonical bytes — the lock-free read, the mutation, and
 *      the usability check `verifyTracker` / `doctor` runs — so a bound cannot
 *      exist in one path and be missing from another. Reads consume at most one
 *      byte over the ceiling (so a file growing under a reader cannot become an
 *      unbounded read), mutations measure their serialized candidate once and
 *      refuse BEFORE the durable replace, and NOTHING is ever pruned or
 *      repaired: a trimmed history is indistinguishable from a history that
 *      was never recorded (Spec #139 / ticket #159).
 *
 * This module is intentionally NOT re-exported by `src/index.ts`: the store
 * layout, the lock envelope, the store ceiling, and the validation contract
 * stay free to evolve behind `TrackerAdapter` until the v1.x surface
 * stabilizes.
 */

export const LOCAL_TRACKER_STORE_DIRECTORY = "poiesis-tracker-v1";
export const LOCAL_TRACKER_STORE_SCHEMA = 1;
export const LOCAL_TRACKER_STORE_PROVIDER = "poiesis-local";
/** Envelope version stamped into `store.lock` / `store.lock.guard`. */
export const LOCAL_TRACKER_LOCK_VERSION = 1;
/** Bounded production wait for the cross-process store lock. */
export const LOCAL_TRACKER_LOCK_TIMEOUT_MS = 30_000;

/**
 * Spec #139 / ticket #159 — the ONE total ceiling on the serialized store.
 *
 * It is a TOTAL size, not a per-item one, because the store is one document:
 * a ceiling that applied to each item separately would bound nothing once a
 * project recorded a few hundred of them. It COUNTS the trailing newline the
 * durable write appends, because the ceiling is on the bytes that exist on
 * disk — the only place this store actually is. A reader that counted the JSON
 * without that newline would accept a store the durable write had already
 * produced over the ceiling, and the very next read of it would have to refuse
 * a document the previous write claimed to have committed.
 *
 * The number is a memory and latency budget, not a policy about how much work
 * a project may record: an operator reaches it by recording more history, and
 * nothing in the runtime prunes, compacts, or repairs anything to keep a write
 * inside it.
 *
 * Module-internal on purpose, like the rest of this module. It bounds ONE
 * store layout; promoting it through `src/index.ts` would freeze the number,
 * the trailing newline it counts, and the `LOCAL_TRACKER_STORE_TOO_LARGE`
 * details into a public API, and would let a caller raise a bound that exists
 * precisely because Poiesis does not read an unbounded document for them.
 */
export const LOCAL_TRACKER_STORE_MAX_BYTES = 16_777_216;

const LOCAL_TRACKER_STORE_FILENAME = "store.json";
const LOCAL_TRACKER_LOCK_FILENAME = "store.lock";
const LOCAL_TRACKER_LOCK_GUARD_FILENAME = "store.lock.guard";
const LOCAL_TRACKER_FILE_MODE = 0o600;
const LOCAL_TRACKER_DIRECTORY_MODE = 0o700;
const LOCAL_TRACKER_LOCK_POLL_INTERVAL_MS = 25;
const LOCAL_TRACKER_RELEASE_GUARD_TIMEOUT_MS = 5_000;
const IS_WINDOWS = process.platform === "win32";

const TRACKER_KINDS: readonly string[] = ["spec", "ticket"];
const TRACKER_STATES: readonly string[] = ["open", "closed", "superseded"];
const HISTORY_OPERATIONS: readonly string[] = ["create", "update", "comment", "close", "supersede"];

export type LocalTrackerState = "open" | "closed" | "superseded";
export type LocalTrackerOperation = "create" | "update" | "comment" | "close" | "supersede";

export interface LocalTrackerStoreLocation {
  gitCommonDir: string;
  directory: string;
  storePath: string;
  lockPath: string;
  guardPath: string;
}

export interface LocalTrackerItemRecord {
  id: string;
  kind: TrackerItemKind;
  title: string;
  body: string;
  state: LocalTrackerState;
  createdAt: string;
  updatedAt: string;
  parentSpecId?: string;
  dependencyText?: string;
  supersededReason?: string;
  supersededBy?: string[];
}

export interface LocalTrackerCommentRecord {
  id: string;
  itemId: string;
  body: string;
  createdAt: string;
}

export interface LocalTrackerHistoryEntry {
  operation: LocalTrackerOperation;
  at: string;
  body?: string;
  snapshot: LocalTrackerItemRecord;
}

export interface LocalTrackerItemFile {
  item: LocalTrackerItemRecord;
  comments: LocalTrackerCommentRecord[];
  history: LocalTrackerHistoryEntry[];
}

export interface LocalTrackerStore {
  schema: 1;
  provider: "poiesis-local";
  nextId: number;
  items: Record<string, LocalTrackerItemFile>;
}

interface LocalTrackerLockContent {
  version: 1;
  token: string;
  pid: number;
  acquiredAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: string, name: string): string {
  invariant(value.trim().length > 0, "INVALID_ADAPTER_INPUT", `${name} must not be empty`, { name });
  return value;
}

function unsafe(path: string, message: string, details: Record<string, unknown> = {}): PoiesisError {
  return new PoiesisError("LOCAL_TRACKER_STORE_UNSAFE", `Refusing to use the local tracker store: ${message}`, {
    path,
    ...details,
  });
}

function invalidStore(message: string, details: Record<string, unknown> = {}): PoiesisError {
  return new PoiesisError("INVALID_LOCAL_TRACKER_STORE", `Refusing to use the local tracker store: ${message}`, details);
}

/**
 * Spec #139 / ticket #159 — the typed refusal for a store over the ceiling,
 * and for a mutation whose CANDIDATE would cross it.
 *
 * The details are INERT, and that is the whole design: the exact store path and
 * two exact numbers, nothing else. Every other operator-facing refusal in this
 * module still states a procedure, because every other one has a procedure an
 * operator can carry out on an artifact Poiesis can verify. This one has none —
 * the store is over the ceiling because the operator's own history is large,
 * and the only thing that changes it is a decision about their work, which is
 * theirs and not Poiesis's. So there is nothing to say that a number does not
 * already say, and a procedure that interpolated the path would hand a command
 * to whatever the Git common directory's name contains: a space, a quote, a
 * `;`, a `$(...)`, a pipe.
 *
 * `sizeBytes` is what Poiesis ACTUALLY CONSUMED, which is at most one byte over
 * the ceiling, and never a recount of the rest of the file. That is a
 * deliberate bound rather than an imprecision: the exact size of a store that is
 * too large to read is not information an operator can act on differently, and
 * producing it would mean reading the document this refusal exists to avoid
 * reading.
 */
function storeTooLarge(path: string, sizeBytes: number): PoiesisError {
  return new PoiesisError(
    "LOCAL_TRACKER_STORE_TOO_LARGE",
    "Refusing to use the local tracker store: it is larger than the total serialized-store ceiling",
    { path, sizeBytes, maxBytes: LOCAL_TRACKER_STORE_MAX_BYTES },
  );
}

// -- Canonical location ------------------------------------------------------

function buildLocation(gitCommonDir: string): LocalTrackerStoreLocation {
  const directory = resolve(gitCommonDir, LOCAL_TRACKER_STORE_DIRECTORY);
  return {
    gitCommonDir,
    directory,
    storePath: resolve(directory, LOCAL_TRACKER_STORE_FILENAME),
    lockPath: resolve(directory, LOCAL_TRACKER_LOCK_FILENAME),
    guardPath: resolve(directory, LOCAL_TRACKER_LOCK_GUARD_FILENAME),
  };
}

/**
 * Resolve the store location from the Git COMMON directory. The Git query is
 * read-only and bounded, and it is the ONLY Git invocation the local tracker
 * ever makes: the store is located, never fetched, and no working tree is
 * read or written.
 *
 * The query itself lives in `src/git-common-dir.ts` (Spec #139 / ticket #156),
 * which owns the explicit timeout, the max-output bound, and the five stable
 * typed refusals. This function adds exactly one thing on top: the
 * canonicalization `realpath` gives, so a repository reached through a
 * symlinked parent still produces ONE store location rather than two.
 *
 * The resolution is synchronous because `TrackerAdapter.project` is a
 * synchronous readonly property and `createTrackerAdapter` returns one
 * synchronously. The exported async form is the same single implementation,
 * so no caller can observe two different locations.
 */
export function resolveLocalTrackerStoreLocationSync(cwd: string): LocalTrackerStoreLocation {
  return buildLocation(realpathSync(discoverGitCommonDir(cwd)));
}

export async function resolveLocalTrackerStoreLocation(cwd: string): Promise<LocalTrackerStoreLocation> {
  return resolveLocalTrackerStoreLocationSync(cwd);
}

/**
 * Refuse a store directory that is a symlink or a non-directory, and a store
 * / lock / guard file that is a symlink or a nonregular file. Poiesis owns
 * these names inside the Git common directory, so anything else at one of them
 * is either a mistake or an attempt to redirect a write, and both fail closed.
 * The directory check is repeated after `mkdir` so the window between the two
 * calls cannot be used to swap a real directory for a symlink.
 */
async function assertSafeDirectory(path: string, label: string): Promise<"absent" | "present"> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (stats.isSymbolicLink()) throw unsafe(path, `the ${label} is a symlink`, { kind: "symlink" });
  if (!stats.isDirectory()) throw unsafe(path, `the ${label} is not a directory`, { kind: "non-directory" });
  return "present";
}

async function assertSafeRegularFile(path: string, label: string): Promise<"absent" | "present"> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (stats.isSymbolicLink()) throw unsafe(path, `the ${label} is a symlink`, { kind: "symlink" });
  if (!stats.isFile()) throw unsafe(path, `the ${label} is not a regular file`, { kind: "non-regular" });
  const mode = stats.mode & 0o777;
  // The store carries the Author's Spec and Ticket text and the dependency
  // evidence attached to them. A file another user can read has already
  // leaked, and silently continuing would compound it; the refusal states the
  // procedure in prose and carries the path and both modes as values.
  if (!IS_WINDOWS && (mode & 0o077) !== 0) {
    // The EXACT path and BOTH modes travel as VALUES, and the repair is PROSE
    // that names no executable. Concatenating `chmod 600 <path>` here would look
    // like the most helpful field on the error and would be the one field that
    // hands a command to whatever the path contains: this store lives inside a
    // Git common directory whose name Poiesis did not choose, so a clone
    // renamed by a human, a checkout under a hostile parent directory, or a path
    // with a space, a quote, a newline, a `;`, or a `$(...)` in it all produce a
    // string that is perfectly safe to READ and dangerous to paste. An operator
    // who trusts an error message is exactly the person who runs it, so the path
    // is a field to act on and the procedure says what to do without ever being
    // executable. The modes are the actionable part and they are plain values, so
    // nothing has to be built to state the repair.
    const currentMode = mode.toString(8);
    const expectedMode = LOCAL_TRACKER_FILE_MODE.toString(8);
    throw unsafe(path, `the ${label} is readable beyond its owner (mode ${currentMode})`, {
      kind: "permissions",
      expectedMode,
      currentMode,
      permissionRecovery: [
        "A local tracker store file carries the Spec and Ticket text of this project together with the dependency " +
          "evidence attached to them, and it is meant to be readable by its owner alone. This refusal is not a " +
          "warning: Poiesis will not read the file, and it will not change the file either, until its permissions " +
          "are narrowed.",
        "Narrow this one file so that only its owner may read it and write it: clear every group permission bit and " +
          "every other-user permission bit, and leave the owner's read bit and write bit in place.",
        "Both numbers you need are on this error rather than in this text. The currentMode value is what the file " +
          "has now, and the expectedMode value is what Poiesis requires, each written as three octal digits for the " +
          "owner, the group, and other users in that order. Clear the last two digits of the first and keep the last " +
          "two digits of the second at zero.",
        "Apply the change with whatever permission facility your platform and your administrator already provide, " +
          "naming the file yourself from the path value on this error. This guidance deliberately describes the " +
          "procedure instead of printing it, so that nothing a path Poiesis did not choose can become an argument, " +
          "a substitution, or a second instruction when you act on it.",
        "Then retry the operation. Poiesis re-establishes the owner-only permissions on every write it makes, so the " +
          "refusal does not come back and this is not a chore to repeat.",
        "Do not widen the file, do not copy it elsewhere, and do not open access to the containing directory " +
          "instead: those changes leave the readable bytes in place rather than removing them, and a store file " +
          "another account can already read has leaked the text it carried.",
      ],
    });
  }
  return "present";
}

// -- Cross-process lock ------------------------------------------------------

function formatLockContent(token: string): string {
  const content: LocalTrackerLockContent = {
    version: LOCAL_TRACKER_LOCK_VERSION,
    token,
    pid: process.pid,
    acquiredAt: Date.now(),
  };
  return JSON.stringify(content);
}

function parseLockContent(raw: string): LocalTrackerLockContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { version, token, pid, acquiredAt } = parsed;
  if (
    version !== LOCAL_TRACKER_LOCK_VERSION ||
    typeof token !== "string" ||
    token.length === 0 ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof acquiredAt !== "number"
  ) {
    return null;
  }
  return { version: 1, token, pid, acquiredAt };
}

/**
 * Read the canonical lock, collapsing BOTH "absent" and "malformed" to `null`.
 *
 * The collapse is deliberate and is why `tryAcquireUnderGuard` then attempts
 * `wx`: a `null` snapshot is a hypothesis, not a fact, and the `wx` is what
 * distinguishes the two. A malformed blob therefore surfaces as `EEXIST`
 * contention and a bounded timeout rather than as a silent overwrite.
 */
async function readLockSnapshot(path: string): Promise<LocalTrackerLockContent | null> {
  try {
    return parseLockContent(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH ("no such process") proves the holder is gone. EPERM means
    // the process exists and simply cannot be signalled by this user, which
    // is the same direction as "alive": never delete a lock someone may hold.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)));
}

async function writeLockExclusive(path: string, token: string): Promise<"written" | "exists"> {
  try {
    await writeFile(path, formatLockContent(token), { flag: "wx", mode: LOCAL_TRACKER_FILE_MODE });
    return "written";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw error;
  }
}

/**
 * Acquire the guard with a bounded wait, or report that it is unavailable.
 *
 * The guard is a SHORT-LIVED serialization signal, not a resource with a
 * lifetime this module may infer. `wx` succeeds for exactly one contender on a
 * given filesystem, and the winner releases it in a `finally` on both the
 * success and the failure path, so a guard that is still present when this
 * function gives up was left there by a process that died inside the critical
 * section.
 *
 * The runtime therefore NEVER auto-reclaims the guard, at any age, on any
 * evidence. A dead PID stamped inside a guard is not proof of a crashed holder
 * (`isPidAlive` returns `true` for any PID it cannot signal, and PID recycling
 * is not observable from a stale envelope), and an automatic removal would let
 * a second process enter the critical section while the real holder is still in
 * it — exactly the double-entry the guard exists to prevent. The same refusal
 * applies to a guard this process itself wrote earlier: removing it
 * unconditionally would be indistinguishable from removing someone else's.
 * Recovery is the operator's decision, and `lockTimeoutError` hands them the
 * exact procedure rather than a guess.
 */
async function acquireGuard(path: string, token: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if ((await writeLockExclusive(path, token)) === "written") return true;
    if (Date.now() >= deadline) return false;
    await sleep(LOCAL_TRACKER_LOCK_POLL_INTERVAL_MS);
  }
}

/**
 * Release a guard this process is holding. Only ever called from a `finally`
 * that follows a successful `acquireGuard`, so it never runs against a guard
 * this process does not own; the `.catch` keeps a vanished guard from turning a
 * completed critical section into a failure.
 */
async function releaseGuard(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

/**
 * The critical section. Runs while the guard is held, so only one contender at
 * a time decides what to do with the canonical lock.
 *
 *   - absent -> `wx` our token. On success the caller owns the lock.
 *   - present, live holder -> report contention WITHOUT mutating anything.
 *   - present, dead holder -> re-read and reclaim ONLY when the token and PID
 *     are still exactly the ones observed, so a replacement lock is never
 *     unlinked. This is the ONE case the runtime resolves on its own, which is
 *     why an operator is never told to remove a stale `store.lock` by hand.
 *   - present, unreadable or malformed -> report contention. The blob is never
 *     unlinked: the runtime cannot tell unknown bytes apart from a foreign lock
 *     it does not own, and guessing is the failure mode this protocol exists to
 *     prevent. This is NOT the guard case and the guard recovery procedure does
 *     not cover it; it is corruption, and clearing it is the operator's call.
 */
async function tryAcquireUnderGuard(
  location: LocalTrackerStoreLocation,
  token: string,
): Promise<"acquired" | "contended"> {
  const snapshot = await readLockSnapshot(location.lockPath);
  if (snapshot === null) {
    return (await writeLockExclusive(location.lockPath, token)) === "written" ? "acquired" : "contended";
  }
  if (await isPidAlive(snapshot.pid)) return "contended";
  const verify = await readLockSnapshot(location.lockPath);
  if (verify === null || verify.token !== snapshot.token || verify.pid !== snapshot.pid) return "contended";
  await unlink(location.lockPath).catch(() => undefined);
  return (await writeLockExclusive(location.lockPath, token)) === "written" ? "acquired" : "contended";
}

async function releaseUnderGuard(location: LocalTrackerStoreLocation, token: string): Promise<void> {
  const snapshot = await readLockSnapshot(location.lockPath);
  if (snapshot === null) return;
  // Only our own token may be removed. A foreign lock is preserved verbatim.
  if (snapshot.token !== token) return;
  await unlink(location.lockPath).catch(() => undefined);
}

async function releaseTokenChecked(location: LocalTrackerStoreLocation, token: string): Promise<void> {
  if (!(await acquireGuard(location.guardPath, randomUUID(), LOCAL_TRACKER_RELEASE_GUARD_TIMEOUT_MS))) {
    // A wedged guard means a crashed holder. Refuse to mutate the canonical
    // lock without the guard rather than risk unlinking a foreign lock; the
    // next acquirer observes the lock, reclaims it if its holder is gone, and
    // proceeds. The guard is NOT cleared here and is never cleared by any code
    // path: the release closure holds no evidence that distinguishes its own
    // wedged guard from one left by another process, so recovering it is the
    // operator's decision, reported by `lockTimeoutError` on the next
    // acquisition that meets the same guard.
    return;
  }
  try {
    await releaseUnderGuard(location, token);
  } finally {
    await releaseGuard(location.guardPath);
  }
}

/**
 * The bounded-wait refusal, carrying everything an operator needs to act.
 *
 * A timeout has two distinguishable causes and the guidance must not blur them:
 *
 *   - the canonical lock is held by a process that is still running, in which
 *     case waiting is correct and nothing should be removed; or
 *   - the guard is present because a process died inside the critical section,
 *     in which case no amount of waiting helps, because the runtime will never
 *     reclaim it.
 *
 * The report therefore carries BOTH exact paths as STRUCTURED fields and states
 * the procedure as PROSE that names the two artifacts by their fixed names.
 * It never builds a command. A path is not a command, and this store lives
 * inside a Git common directory whose name Poiesis did not choose: a clone
 * renamed by a human, a checkout under a hostile parent directory, or a path
 * with a space in it all produce a string that is perfectly safe to READ and
 * dangerous to paste into a shell. Concatenating `rm <path>` into operator
 * guidance therefore hands a command to whatever the path contains — a second
 * argument, a command substitution, a pipe — and an operator who trusts an
 * error message is exactly the person who will run it. So the exact paths
 * travel as `lockPath` / `guardPath` / `storePath` values a reader or Poiesis
 * can act on, and the prose says what to do without ever being executable.
 *
 * The canonical `store.lock` is deliberately NOT a removal target: it already
 * has the ordinary holder-PID and ownership-token check, so a stale one is
 * reclaimed by the runtime inside the very bounded wait that just expired.
 * Telling an operator to delete it by hand would bypass the identity check
 * that makes the protocol safe — a hand-deleted live lock admits a second
 * writer — to fix a problem the runtime does not have.
 */
function lockTimeoutError(location: LocalTrackerStoreLocation, timeoutMs: number): PoiesisError {
  return new PoiesisError(
    "LOCAL_TRACKER_LOCK_TIMEOUT",
    "The local tracker store lock could not be acquired within the bounded wait",
    {
      // The EXACT paths, as values. `path` is the canonical lock, kept for
      // consumers that already read it; `lockPath` / `guardPath` / `storePath`
      // are the unambiguous names.
      path: location.lockPath,
      lockPath: location.lockPath,
      guardPath: location.guardPath,
      storePath: location.storePath,
      gitCommonDir: location.gitCommonDir,
      timeoutMs,
      // Prose only. Not one character in these steps has a meaning to a shell,
      // and no step interpolates a path, so no step can become a command.
      guardRecovery: [
        "First verify that no Poiesis process is accessing this clone: a store.lock.guard is never reclaimed by " +
          "the runtime, whatever its stamped holder PID says, because a dead PID cannot distinguish a crashed holder " +
          "from a live process this process may not signal.",
        "Then remove only the exact store.lock.guard artifact, and nothing else. The exact path is the guardPath " +
          "value on this error, and this guidance names the artifact instead of printing a command for it, so " +
          "nothing here is meant to be run as written.",
        "Then retry the operation, and with the guard gone the next acquirer enters the critical section normally.",
        "Never remove the canonical store.lock to clear a stale holder: its holder PID and ownership token already " +
          "reclaim one within the bounded wait, and a hand-deleted live lock would admit a second writer and break " +
          "the exclusivity this lock exists to provide.",
      ],
    },
  );
}

/**
 * Acquire the store lock, waiting at most `timeoutMs`. Exported so the
 * contention, token-checked-release, and bounded-stale-recovery evidence can
 * drive the protocol directly; production callers go through the adapter.
 *
 * The bounded wait has two outcomes that are both normal and both refusals: a
 * canonical lock held by a live process, and a guard left by a crashed holder.
 * Only the second is operator-recoverable, and the loop below never tries to
 * recover either one itself.
 */
export async function acquireLocalTrackerLockWithTimeout(
  location: LocalTrackerStoreLocation,
  timeoutMs: number,
): Promise<() => Promise<void>> {
  await mkdir(location.directory, { recursive: true, mode: LOCAL_TRACKER_DIRECTORY_MODE });
  await assertSafeDirectory(location.directory, "store directory");
  await assertSafeRegularFile(location.lockPath, "store lock");
  await assertSafeRegularFile(location.guardPath, "store lock guard");
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw lockTimeoutError(location, timeoutMs);
    }
    const gotGuard = await acquireGuard(
      location.guardPath,
      randomUUID(),
      Math.min(LOCAL_TRACKER_LOCK_POLL_INTERVAL_MS, remaining),
    );
    if (!gotGuard) {
      await sleep(Math.min(LOCAL_TRACKER_LOCK_POLL_INTERVAL_MS, deadline - Date.now()));
      continue;
    }
    let acquired = false;
    try {
      acquired = (await tryAcquireUnderGuard(location, token)) === "acquired";
    } finally {
      await releaseGuard(location.guardPath);
    }
    if (acquired) return async () => releaseTokenChecked(location, token);
    await sleep(Math.min(LOCAL_TRACKER_LOCK_POLL_INTERVAL_MS, deadline - Date.now()));
  }
}

export async function acquireLocalTrackerLock(
  location: LocalTrackerStoreLocation,
): Promise<() => Promise<void>> {
  return acquireLocalTrackerLockWithTimeout(location, LOCAL_TRACKER_LOCK_TIMEOUT_MS);
}

/**
 * Release the store lock, unlinking it ONLY when the canonical envelope still
 * carries `token`. Exported so the identity-safety evidence can assert that a
 * process can never remove a lock it does not own.
 */
export async function releaseLocalTrackerLock(
  location: LocalTrackerStoreLocation,
  token: string,
): Promise<void> {
  await mkdir(location.directory, { recursive: true, mode: LOCAL_TRACKER_DIRECTORY_MODE });
  await assertSafeDirectory(location.directory, "store directory");
  await releaseTokenChecked(location, token);
}

// -- Durable store write -----------------------------------------------------

/**
 * fsync the temporary bytes, atomically `rename` them over the destination,
 * then fsync the containing directory. The directory fsync is what makes the
 * RENAME itself durable; without it a crash can lose a committed write even
 * though the bytes were flushed. Windows cannot fsync a directory handle, so
 * the step is skipped there (the replace is still atomic).
 */
async function durableReplace(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: LOCAL_TRACKER_DIRECTORY_MODE });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", LOCAL_TRACKER_FILE_MODE);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    if (!IS_WINDOWS) {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

const TEMPORARY_PATTERN = /^store\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/**
 * Remove temporary files abandoned by a process that died mid-write. The
 * canonical document is never named like a temporary, so this can only reclaim
 * unreferenced bytes; the name pattern is exact and every candidate is
 * re-checked as a regular file before unlink, so a planted symlink is never
 * followed.
 */
async function removeAbandonedTemporaries(location: LocalTrackerStoreLocation): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(location.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!TEMPORARY_PATTERN.test(entry)) continue;
    const path = resolve(location.directory, entry);
    const stats = await lstat(path).catch(() => null);
    if (stats === null || stats.isSymbolicLink() || !stats.isFile()) continue;
    await unlink(path).catch(() => undefined);
  }
}

// -- Strict store validation -------------------------------------------------

/**
 * The prefix every LOCAL identifier starts with. Split out because a caller
 * that uses it is CLAIMING to name a Poiesis item, and a claim that cannot be
 * canonical is a different mistake from a name this tracker never issued.
 */
const LOCAL_ID_PREFIX = "LOCAL-";

/**
 * Spec #139 / ticket #158 — `LOCAL-` followed by a NONZERO decimal integer with
 * no leading zero, and nothing else.
 *
 * The former `/^LOCAL-(\d+)$/` accepted `LOCAL-01`, so `LOCAL-01` and `LOCAL-1`
 * were two spellings of item number 1. A store could hold both, the monotonic
 * counter check could not see the alias because both keys collapsed to the same
 * number, and a parent or supersession reference could be PERSISTED in the padded
 * spelling while naming an item the caller never typed. Canonical form is what
 * makes one identifier mean exactly one item, so the leading digit is required
 * to be `1`-`9`: `LOCAL-0` is not an identity a monotonic counter can issue, and
 * `LOCAL-01` is a second spelling of one it already did.
 */
const LOCAL_ID_PATTERN = /^LOCAL-([1-9][0-9]*)$/;

/**
 * The item number a canonical LOCAL identifier names, or `null` when the text is
 * not one. A number Poiesis cannot represent as a safe integer (`LOCAL-` plus 20
 * digits) is refused exactly like a non-LOCAL value rather than silently
 * truncated into a number that aliases a real item.
 */
function localIdNumber(id: string): number | null {
  const match = LOCAL_ID_PATTERN.exec(id);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function requireLocalId(value: unknown, label: string): string {
  if (typeof value !== "string" || localIdNumber(value) === null) {
    throw invalidStore(`${label} is not a canonical LOCAL identifier`, { label, value });
  }
  return value;
}

/**
 * Spec #139 / ticket #158 — a caller-supplied item identifier.
 *
 * Blank text is refused by `requiredText`, and text that CLAIMS the `LOCAL-`
 * prefix must then be canonical: a padded spelling names a number this tracker
 * issues under exactly one spelling, so accepting it would let two names for one
 * identity reach the store. Text that does not claim the prefix is not a LOCAL
 * identifier at all and keeps the ordinary unknown-identifier refusal, so a
 * JavaScript prototype member still reports `TRACKER_ITEM_NOT_FOUND` (ticket
 * #150) rather than a canonicality complaint it has nothing to do with.
 */
function requireCallerLocalId(value: string, name: string): string {
  const text = requiredText(value, name);
  if (text.startsWith(LOCAL_ID_PREFIX) && localIdNumber(text) === null) {
    throw new PoiesisError("INVALID_ADAPTER_INPUT", `${name} must be a canonical LOCAL identifier`, {
      name,
      value: text,
      pattern: LOCAL_ID_PATTERN.source,
    });
  }
  return text;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw invalidStore(`${label} is not a timestamp`, { label, value });
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalidStore(`${label} must be a string`, { label });
  return value;
}

function parseItemRecord(id: string, value: unknown): LocalTrackerItemRecord {
  if (!isRecord(value)) throw invalidStore("an item record is not an object", { id });
  if (value.id !== id) {
    throw invalidStore("an item record's identifier does not match its key", { key: id, id: value.id });
  }
  if (typeof value.kind !== "string" || !TRACKER_KINDS.includes(value.kind)) {
    throw invalidStore("an item has an unknown kind", { id, kind: value.kind });
  }
  if (typeof value.state !== "string" || !TRACKER_STATES.includes(value.state)) {
    throw invalidStore("an item has an unknown state", { id, state: value.state });
  }
  const kind = value.kind as TrackerItemKind;
  const state = value.state as LocalTrackerState;
  const item: LocalTrackerItemRecord = {
    id,
    kind,
    title: requireString(value.title, `${id} title`),
    body: requireString(value.body, `${id} body`),
    state,
    createdAt: requireTimestamp(value.createdAt, `${id} createdAt`),
    updatedAt: requireTimestamp(value.updatedAt, `${id} updatedAt`),
  };
  if (kind === "ticket") {
    // A ticket is meaningless without its parent Spec and its dependency text,
    // and both are Author-supplied evidence: a store missing either has lost
    // the claim the ticket made.
    item.parentSpecId = requireLocalId(value.parentSpecId, `${id} parentSpecId`);
    item.dependencyText = requireString(value.dependencyText, `${id} dependencyText`);
    if (item.dependencyText.trim().length === 0) {
      throw invalidStore("a ticket's dependency text is empty", { id });
    }
  } else if (value.parentSpecId !== undefined || value.dependencyText !== undefined) {
    throw invalidStore("a Spec carries a parent or dependency text", { id });
  }
  if (state === "superseded") {
    if (typeof value.supersededReason !== "string" || value.supersededReason.trim().length === 0) {
      throw invalidStore("a superseded item has no supersession reason", { id });
    }
    if (
      !Array.isArray(value.supersededBy) ||
      !value.supersededBy.every((entry) => typeof entry === "string" && localIdNumber(entry) !== null)
    ) {
      throw invalidStore("a superseded item has an invalid replacement list", { id });
    }
    item.supersededReason = value.supersededReason;
    item.supersededBy = [...(value.supersededBy as string[])];
  } else if (value.supersededReason !== undefined || value.supersededBy !== undefined) {
    throw invalidStore("a non-superseded item carries supersession metadata", { id, state });
  }
  return item;
}

function parseItemFile(key: string, value: unknown): LocalTrackerItemFile {
  if (!isRecord(value)) throw invalidStore("an item entry is not an object", { id: key });
  if (!Array.isArray(value.comments)) throw invalidStore("an item entry has no comment list", { id: key });
  if (!Array.isArray(value.history)) throw invalidStore("an item entry has no history list", { id: key });
  const comments = value.comments.map((entry, index) => {
    if (!isRecord(entry)) throw invalidStore("a comment is not an object", { id: key, index });
    if (entry.itemId !== key) {
      throw invalidStore("a comment points at a different item", { id: key, commentItemId: entry.itemId });
    }
    const commentId = requireString(entry.id, `${key} comment id`);
    if (!new RegExp(`^${key}-C[1-9][0-9]*$`).test(commentId)) {
      throw invalidStore("a comment identifier is not derived from its item", { id: key, commentId });
    }
    return {
      id: commentId,
      itemId: key,
      body: requireString(entry.body, `${key} comment body`),
      createdAt: requireTimestamp(entry.createdAt, `${key} comment createdAt`),
    } satisfies LocalTrackerCommentRecord;
  });
  if (new Set(comments.map((comment) => comment.id)).size !== comments.length) {
    throw invalidStore("an item has duplicate comment identifiers", { id: key });
  }
  const history = value.history.map((entry, index) => {
    if (!isRecord(entry)) throw invalidStore("a history entry is not an object", { id: key, index });
    if (typeof entry.operation !== "string" || !HISTORY_OPERATIONS.includes(entry.operation)) {
      throw invalidStore("a history entry has an unknown operation", { id: key, operation: entry.operation });
    }
    const parsed: LocalTrackerHistoryEntry = {
      operation: entry.operation as LocalTrackerOperation,
      at: requireTimestamp(entry.at, `${key} history at`),
      snapshot: parseItemRecord(key, entry.snapshot),
    };
    if (entry.body !== undefined) parsed.body = requireString(entry.body, `${key} history body`);
    return parsed;
  });
  return { item: parseItemRecord(key, value.item), comments, history };
}

/** Parse and STRICTLY validate a store document. Never repairs, never guesses. */
export function parseLocalTrackerStore(raw: string): LocalTrackerStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalidStore("the store document is not valid JSON", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isRecord(parsed)) throw invalidStore("the store document is not an object");
  if (parsed.schema !== LOCAL_TRACKER_STORE_SCHEMA) {
    throw invalidStore("the store schema version is not supported", {
      schema: parsed.schema,
      supported: LOCAL_TRACKER_STORE_SCHEMA,
    });
  }
  if (parsed.provider !== LOCAL_TRACKER_STORE_PROVIDER) {
    throw invalidStore("the store was not written by the local tracker", {
      provider: parsed.provider,
      expected: LOCAL_TRACKER_STORE_PROVIDER,
    });
  }
  if (typeof parsed.nextId !== "number" || !Number.isSafeInteger(parsed.nextId) || parsed.nextId < 1) {
    throw invalidStore("the identifier counter is not a positive integer", { nextId: parsed.nextId });
  }
  if (!isRecord(parsed.items)) throw invalidStore("the store has no item map");
  const items: Record<string, LocalTrackerItemFile> = {};
  const owners = new Map<number, string>();
  let highest = 0;
  for (const key of Object.keys(parsed.items)) {
    const number = localIdNumber(key);
    if (number === null) throw invalidStore("an item key is not a canonical LOCAL identifier", { key });
    // Ticket #158: two keys resolving to the SAME number would make the
    // counter's monotonicity check blind — `highest` could not tell the
    // collision from one item — so the document is refused by number rather
    // than by spelling as well.
    const owner = owners.get(number);
    if (owner !== undefined) {
      throw invalidStore("two item keys name the same LOCAL number", { keys: [owner, key], number });
    }
    owners.set(number, key);
    highest = Math.max(highest, number);
    items[key] = parseItemFile(key, parsed.items[key]);
  }
  if (parsed.nextId <= highest) {
    // A counter at or below an issued identifier would let the next create
    // alias or overwrite an existing item. Monotonicity is the one property
    // that cannot be repaired, so a store that violates it is refused.
    throw invalidStore("the identifier counter is not monotonic", { nextId: parsed.nextId, highest });
  }
  return {
    schema: LOCAL_TRACKER_STORE_SCHEMA,
    provider: LOCAL_TRACKER_STORE_PROVIDER,
    nextId: parsed.nextId,
    items,
  };
}

function emptyStore(): LocalTrackerStore {
  return { schema: LOCAL_TRACKER_STORE_SCHEMA, provider: LOCAL_TRACKER_STORE_PROVIDER, nextId: 1, items: {} };
}

// -- The bounded load ---------------------------------------------------------

/**
 * Spec #139 / ticket #159 — read at most `max + 1` bytes of the canonical
 * document, or refuse.
 *
 * ONE BYTE OVER THE CEILING IS THE WHOLE POINT, because `stat` cannot bound a
 * read. The file may grow between the stat and the read, and between two
 * chunks of the same read: a store that measured 4 KiB when it was opened can
 * be 40 MiB by the time the bytes arrive, so a read sized from the stat reads
 * all of it. This loop instead stops at `max + 1` and treats holding that last
 * byte as the whole answer — the document is over the ceiling, and one byte is
 * the entire fact needed to say so. Nothing further is read to count the rest,
 * so the refusal's `sizeBytes` is bounded too.
 *
 * The loop, rather than one `read`, is what makes a growth race safe in the
 * other direction. A short read is legal, and treating the first short read as
 * the end of the file would hand the parser a TRUNCATED document and report
 * corruption for a store that is perfectly valid — which is a worse failure
 * than refusing an oversized one, because it tells the operator their history
 * is damaged. The buffer is therefore only ever allowed to GROW, and only up to
 * the bound: past `max + 1` there is nothing further to learn.
 */
async function readStoreBytesBounded(path: string): Promise<string> {
  const ceiling = LOCAL_TRACKER_STORE_MAX_BYTES;
  const handle = await open(path, "r");
  try {
    // An ordinary store gets a buffer the size of an ordinary store; a store
    // already over the ceiling gets exactly the bound and never more.
    const stats = await handle.stat();
    let buffer = Buffer.allocUnsafe(Math.min(ceiling + 1, Math.max(stats.size, 0) + 1));
    let filled = 0;
    for (;;) {
      if (filled === buffer.length) {
        if (buffer.length >= ceiling + 1) break;
        // The file grew past what the stat reported, so from here the bound is
        // the only thing allowed to decide how much to hold.
        const grown = Buffer.allocUnsafe(ceiling + 1);
        buffer.copy(grown, 0, 0, filled);
        buffer = grown;
      }
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > ceiling) throw storeTooLarge(path, filled);
    return buffer.toString("utf8", 0, filled);
  } finally {
    await handle.close();
  }
}

/**
 * Spec #139 / ticket #159 — the ONE bounded load of the canonical document.
 *
 * Three callers need these bytes — the lock-free read, the mutation's
 * read-modify-write, and the `verifyTracker` / `doctor` usability check — and
 * the bound has to hold for all three or it does not hold. A read path that
 * checked the size and a mutation path that did not would let a store grow
 * past the ceiling through the second one and then refuse to open itself
 * through the first; a usability check that did not check it would report a
 * healthy tracker whose every later operation is refused. So there is one
 * function, and the ceiling is a property of the BYTES rather than of a call
 * site.
 *
 * The size is settled before `parseLocalTrackerStore` sees a single character,
 * which is what makes the refusal a fact about the store rather than a verdict
 * about its contents: bytes that are not JSON at all, truncated mid-document,
 * or a valid document one byte too large are all the same refusal. For the
 * lock-free read there is no lock to settle it without, and the size does not
 * depend on one; the mutation settles it inside the critical section, because
 * a read outside the lock would be a different document than the one it is
 * about to replace.
 */
async function loadLocalTrackerStore(location: LocalTrackerStoreLocation): Promise<LocalTrackerStore> {
  await assertSafeDirectory(location.directory, "store directory");
  // An ABSENT store is a project that has not recorded its first Spec yet, not
  // a zero-byte one, so it is valid and never measured.
  if ((await assertSafeRegularFile(location.storePath, "store")) === "absent") return emptyStore();
  return parseLocalTrackerStore(await readStoreBytesBounded(location.storePath));
}

/**
 * The canonical serialization, formed ONCE per mutation and then both measured
 * and written. Serializing twice — once to size, once to write — would leave a
 * window in which the two differ, and `JSON.stringify` of a document this size
 * is not free. The trailing newline is part of the string so the measured
 * length is the length of the bytes that reach the disk.
 */
function serializeLocalTrackerStore(store: LocalTrackerStore): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

// -- Adapter -----------------------------------------------------------------

function assertLocalKind(item: LocalTrackerItemRecord, expected: TrackerItemKind): LocalTrackerItemRecord {
  invariant(
    item.kind === expected,
    "TRACKER_ITEM_KIND_MISMATCH",
    `Local tracker item ${item.id} is not a ${expected}`,
    { id: item.id, expected, actual: item.kind },
  );
  return item;
}

/**
 * Resolve one item from the store.
 *
 * Membership is checked with `Object.hasOwn`, never with a bare bracket read
 * whose result is compared to `undefined`. `store.items` is a plain object, so
 * `items["__proto__"]`, `items["constructor"]`, and `items["toString"]` all
 * return something real — an inherited object or function — where the caller
 * asked for a tracker item. Testing the value would turn every one of those
 * identifiers into a `TypeError` raised while reading a field off
 * `Object.prototype`, with no code for an operator to branch on, and would
 * leave an inherited value one refactor away from being read as Poiesis
 * content. Own-property membership asks the only question that matters — is
 * this key an item THIS store issued — so an identifier that merely names a
 * prototype member is an unknown identifier and gets the ordinary typed
 * refusal.
 */
function localRecord(store: LocalTrackerStore, id: string, kind?: TrackerItemKind): LocalTrackerItemFile {
  const normalized = requiredText(id, "id");
  if (!Object.hasOwn(store.items, normalized)) {
    throw new PoiesisError("TRACKER_ITEM_NOT_FOUND", `Local tracker item ${normalized} was not found`, {
      id: normalized,
    });
  }
  const record = store.items[normalized] as LocalTrackerItemFile;
  if (kind !== undefined) assertLocalKind(record.item, kind);
  return record;
}

function toTrackerItem(item: LocalTrackerItemRecord, storeUrl: string): TrackerItem {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    state: item.state,
    url: `${storeUrl}#${item.id}`,
    ...(item.parentSpecId === undefined ? {} : { parentSpecId: item.parentSpecId }),
    ...(item.dependencyText === undefined ? {} : { dependencyText: item.dependencyText }),
    ...(item.supersededBy === undefined ? {} : { supersededBy: [...item.supersededBy] }),
    ...(item.supersededReason === undefined ? {} : { supersededReason: item.supersededReason }),
  };
}

function toTrackerComment(comment: LocalTrackerCommentRecord, storeUrl: string): TrackerComment {
  return { id: comment.id, itemId: comment.itemId, body: comment.body, url: `${storeUrl}#${comment.id}` };
}

function touch(record: LocalTrackerItemFile, operation: LocalTrackerOperation): void {
  const at = new Date().toISOString();
  record.item.updatedAt = at;
  record.history.push({ operation, at, snapshot: structuredClone(record.item) });
}

/**
 * Next comment identifier for an item.
 *
 * Derived from the HIGHEST existing numeric suffix, never from the comment
 * count. The strict validator accepts any unique `LOCAL-<n>-C<m>` sequence, so
 * a valid store can legitimately carry a noncontiguous imported run such as
 * `C2, C3`; `comments.length + 1` would then mint `C3` again and write a
 * self-invalidating duplicate that the next read refuses. Highest-suffix + 1
 * cannot collide with any identifier already present.
 */
function nextCommentId(itemId: string, comments: readonly LocalTrackerCommentRecord[]): string {
  let highest = 0;
  for (const comment of comments) {
    const match = /-C([0-9]+)$/.exec(comment.id);
    if (match === null) continue;
    highest = Math.max(highest, Number(match[1]));
  }
  return `${itemId}-C${highest + 1}`;
}

class LocalTrackerAdapter implements TrackerAdapter {
  readonly provider = "local" as const;
  readonly project: string;
  private readonly location: LocalTrackerStoreLocation;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(cwd: string) {
    this.location = resolveLocalTrackerStoreLocationSync(cwd);
    this.project = this.location.storePath;
  }

  createSpec(input: CreateSpecInput): Promise<TrackerItem> {
    return this.create("spec", input);
  }

  async getSpec(id: string): Promise<TrackerItem> {
    // The caller's identifier is checked before the store is even read, so a
    // padded spelling costs nothing and cannot be answered out of a document.
    const target = requireCallerLocalId(id, "id");
    const record = localRecord(await this.read(), target, "spec");
    return toTrackerItem(record.item, this.storeUrl);
  }

  updateSpec(id: string, input: UpdateTrackerItemInput): Promise<TrackerItem> {
    return this.update(id, "spec", input);
  }

  commentSpec(id: string, body: string): Promise<TrackerComment> {
    return this.comment(id, "spec", body);
  }

  closeSpec(id: string): Promise<TrackerItem> {
    return this.close(id, "spec");
  }

  supersedeSpec(id: string, input: SupersedeInput): Promise<TrackerItem> {
    return this.supersede(id, "spec", input);
  }

  async createTicket(input: CreateTicketInput): Promise<TrackerItem> {
    // Ticket #158: a parent reference is PERSISTED, so a padded one would commit
    // a document this adapter's own strict validator can never read back. It is
    // refused here, on the caller's input, before the mutation.
    const parentSpecId = requireCallerLocalId(input.parentSpecId, "parentSpecId");
    const dependencyText = requiredText(input.dependencyText, "dependencyText");
    // Parent validation happens INSIDE the mutation, against the same store
    // snapshot the mutation is about to rewrite, so a ticket can never be
    // created against a parent that is missing or is not a Spec.
    return this.create("ticket", { ...input, parentSpecId, dependencyText });
  }

  async getTicket(id: string): Promise<TrackerItem> {
    const target = requireCallerLocalId(id, "id");
    const record = localRecord(await this.read(), target, "ticket");
    return toTrackerItem(record.item, this.storeUrl);
  }

  updateTicket(id: string, input: UpdateTicketInput): Promise<TrackerItem> {
    return this.update(id, "ticket", input);
  }

  commentTicket(id: string, body: string): Promise<TrackerComment> {
    return this.comment(id, "ticket", body);
  }

  closeTicket(id: string): Promise<TrackerItem> {
    return this.close(id, "ticket");
  }

  supersedeTicket(id: string, input: SupersedeInput): Promise<TrackerItem> {
    return this.supersede(id, "ticket", input);
  }

  private get storeUrl(): string {
    return pathToFileURL(this.location.storePath).href;
  }

  /**
   * Lock-free read. The atomic replace guarantees a complete document, so no
   * cross-process lock is needed. It DOES wait for this instance's own
   * in-flight mutations, so `Promise.all([createSpec(...), getSpec(...)])` in
   * one process observes the committed state rather than racing it.
   *
   * Ticket #159: the load goes through the ONE bounded loader, so this path
   * inherits the store ceiling for free. A live foreign lock, a foreign
   * temporary, and a concurrent writer are all invisible here, and an
   * over-ceiling store is refused from its bytes alone — never as a lock
   * timeout, and never as a parse failure.
   */
  private async read(): Promise<LocalTrackerStore> {
    await this.pending;
    return loadLocalTrackerStore(this.location);
  }

  /**
   * Serialize a read-modify-write across every writer in every process. The
   * queue serializes this process; the store lock serializes the machine.
   * Both release on the failure path, so a rejected mutation leaves the store
   * exactly as it found it.
   */
  private async mutate<T>(operation: (store: LocalTrackerStore) => T): Promise<T> {
    const result = this.pending.then(async () => {
      const location = this.location;
      await assertSafeDirectory(location.directory, "store directory");
      await assertSafeRegularFile(location.storePath, "store");
      const release = await acquireLocalTrackerLock(location);
      try {
        await removeAbandonedTemporaries(location);
        const store = await loadLocalTrackerStore(location);
        const value = operation(store);
        // Ticket #159: the candidate is serialized ONCE, measured, and only
        // then written — and the refusal comes BEFORE `durableReplace`, so no
        // temporary file is ever created, no `fsync` is skipped, no mode is
        // lost, and the canonical bytes are exactly the ones already there.
        // The `finally` below still releases the lock it holds, so a refused
        // mutation leaves no lock and no guard behind either, and the next
        // fitting mutation in this process or any other proceeds normally.
        const candidate = serializeLocalTrackerStore(store);
        const candidateBytes = Buffer.byteLength(candidate, "utf8");
        if (candidateBytes > LOCAL_TRACKER_STORE_MAX_BYTES) {
          throw storeTooLarge(location.storePath, candidateBytes);
        }
        await durableReplace(location.storePath, candidate);
        return value;
      } finally {
        await release();
      }
    });
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  /**
   * `async` on every validating method so an input rejection is a REJECTED
   * promise, never a synchronous throw out of a `Promise`-returning method.
   * A caller that only awaits the adapter must not have to wrap each call in
   * a `try` around the call expression as well as the `await`.
   */
  private async create(kind: TrackerItemKind, input: CreateSpecInput | CreateTicketInput): Promise<TrackerItem> {
    const title = requiredText(input.title, "title");
    invariant(typeof input.body === "string", "INVALID_ADAPTER_INPUT", "body must be a string", { name: "body" });
    return this.mutate((store) => {
      if (kind === "ticket") localRecord(store, (input as CreateTicketInput).parentSpecId, "spec");
      const id = `LOCAL-${store.nextId}`;
      store.nextId += 1;
      const now = new Date().toISOString();
      const item: LocalTrackerItemRecord = {
        id,
        kind,
        title,
        body: input.body,
        state: "open",
        createdAt: now,
        updatedAt: now,
        ...(kind === "ticket"
          ? {
              parentSpecId: (input as CreateTicketInput).parentSpecId,
              // Stored byte-for-byte. Dependency text is Author evidence about
              // ordering; trimming or reflowing it would change the claim.
              dependencyText: (input as CreateTicketInput).dependencyText,
            }
          : {}),
      };
      store.items[id] = {
        item,
        comments: [],
        history: [{ operation: "create", at: now, snapshot: structuredClone(item) }],
      };
      return toTrackerItem(item, this.storeUrl);
    });
  }

  private async update(
    id: string,
    kind: TrackerItemKind,
    input: UpdateTicketInput | UpdateTrackerItemInput,
  ): Promise<TrackerItem> {
    const target = requireCallerLocalId(id, "id");
    if (input.title !== undefined) requiredText(input.title, "title");
    if (input.body !== undefined && typeof input.body !== "string") {
      throw new PoiesisError("INVALID_ADAPTER_INPUT", "body must be a string", { name: "body" });
    }
    const dependencyText = "dependencyText" in input ? input.dependencyText : undefined;
    if (dependencyText !== undefined) requiredText(dependencyText, "dependencyText");
    return this.mutate((store) => {
      const record = localRecord(store, target, kind);
      if (input.title !== undefined) record.item.title = input.title;
      if (input.body !== undefined) record.item.body = input.body;
      if (kind === "ticket" && dependencyText !== undefined) record.item.dependencyText = dependencyText;
      touch(record, "update");
      return toTrackerItem(record.item, this.storeUrl);
    });
  }

  private async comment(id: string, kind: TrackerItemKind, body: string): Promise<TrackerComment> {
    const target = requireCallerLocalId(id, "id");
    const text = requiredText(body, "comment body");
    return this.mutate((store) => {
      const record = localRecord(store, target, kind);
      const at = new Date().toISOString();
      const comment: LocalTrackerCommentRecord = {
        id: nextCommentId(record.item.id, record.comments),
        itemId: record.item.id,
        body: text,
        createdAt: at,
      };
      record.comments.push(comment);
      record.item.updatedAt = at;
      record.history.push({
        operation: "comment",
        at,
        body: comment.body,
        snapshot: structuredClone(record.item),
      });
      return toTrackerComment(comment, this.storeUrl);
    });
  }

  private async close(id: string, kind: TrackerItemKind): Promise<TrackerItem> {
    const target = requireCallerLocalId(id, "id");
    return this.mutate((store) => {
      const record = localRecord(store, target, kind);
      // A superseded item stays superseded: a later close must not erase the
      // fact that a replacement exists.
      if (record.item.state !== "superseded") record.item.state = "closed";
      touch(record, "close");
      return toTrackerItem(record.item, this.storeUrl);
    });
  }

  private async supersede(id: string, kind: TrackerItemKind, input: SupersedeInput): Promise<TrackerItem> {
    const target = requireCallerLocalId(id, "id");
    const reason = requiredText(input.reason, "supersede reason");
    const replacementIds = [...(input.replacementIds ?? [])];
    // `supersededBy` is PERSISTED, and the strict store validator refuses any
    // entry that is not a CANONICAL LOCAL identifier. An unvalidated value would
    // commit a store this adapter itself can never read again, so the same
    // invariant is enforced HERE, on the caller's input, before the mutation. A
    // replacement this tracker never issued is a caller mistake, not a store to
    // repair: a cross-provider id (`ENG-123`) is precisely the shape the
    // validator refuses, and a padded one (`LOCAL-01`) is a second spelling of a
    // number the validator issues under exactly one. Either way, accepting it
    // would convert one bad argument into a permanently unreadable store.
    for (const replacementId of replacementIds) {
      invariant(
        typeof replacementId === "string" && localIdNumber(replacementId) !== null,
        "INVALID_ADAPTER_INPUT",
        "A supersession replacement must be a canonical LOCAL identifier issued by this tracker",
        { name: "replacementIds", value: replacementId, pattern: LOCAL_ID_PATTERN.source },
      );
    }
    return this.mutate((store) => {
      const record = localRecord(store, target, kind);
      const at = new Date().toISOString();
      record.item.state = "superseded";
      record.item.supersededReason = reason;
      record.item.supersededBy = replacementIds;
      record.item.updatedAt = at;
      const comment: LocalTrackerCommentRecord = {
        id: nextCommentId(record.item.id, record.comments),
        itemId: record.item.id,
        body: `Superseded: ${reason}${replacementIds.length === 0 ? "" : `\n\nReplaced by: ${replacementIds.join(", ")}`}`,
        createdAt: at,
      };
      record.comments.push(comment);
      record.history.push({
        operation: "supersede",
        at,
        body: comment.body,
        snapshot: structuredClone(record.item),
      });
      return toTrackerItem(record.item, this.storeUrl);
    });
  }
}

export function createLocalTrackerAdapter(cwd: string = process.cwd()): TrackerAdapter {
  return new LocalTrackerAdapter(cwd);
}

/**
 * Validate that the store this location names is actually USABLE, without
 * creating or mutating anything. `verifyTracker` and therefore `doctor` depend
 * on the difference between "the paths look right" and "the tracker works": a
 * present but corrupt store must fail closed here rather than let them report a
 * healthy tracker whose every later operation will be refused. An ABSENT store
 * is valid — a project that has not created its first Spec yet has nothing to
 * validate.
 *
 * Ticket #159: it runs the SAME bounded loader as the read and the mutation, so
 * an over-ceiling store is reported as a failing tracker check carrying the
 * bounded `LOCAL_TRACKER_STORE_TOO_LARGE` refusal rather than as a healthy
 * tracker whose first mutation is refused.
 */
export async function assertLocalTrackerStoreUsable(location: LocalTrackerStoreLocation): Promise<void> {
  // Strictly loaded and then discarded: the validator is the check, and it
  // throws rather than repairing, so a malformed document is a typed refusal.
  await loadLocalTrackerStore(location);
}

// -- Spec #190 / ticket #195: retained history and the explicit purge ---------

/**
 * Spec #190 / ticket #195 — what a Local tracker store holds, reported WITHOUT
 * touching it.
 *
 * An ordinary `uninstall` removes every artifact it can attribute to itself and
 * deliberately RETAINS this store, because it is the Author's own recorded work
 * (Specs, tickets, comments, history) rather than an installation artifact. The
 * retained history must still be REPORTED, and — the property this function
 * exists to keep honest — it must never be a reason to call an otherwise
 * complete runtime uninstall incomplete.
 *
 * Everything here is read-only and bounded: the same ONE bounded loader the
 * read and mutation paths use, so a store over the ceiling reports `null`
 * counts instead of being read whole. An UNREADABLE store is still retained user
 * data, so a parse failure reports presence with `null` counts rather than
 * pretending nothing is there.
 */
export interface LocalTrackerHistoryReport {
  /** `true` when a store directory exists at the canonical location. */
  present: boolean;
  /** The store directory, or `null` when nothing is recorded. */
  path: string | null;
  /** Specs recorded, or `null` when the store could not be read. */
  specs: number | null;
  /** Tickets recorded, or `null` when the store could not be read. */
  tickets: number | null;
}

export async function inspectLocalTrackerHistory(cwd: string): Promise<LocalTrackerHistoryReport> {
  let location: LocalTrackerStoreLocation;
  try {
    location = resolveLocalTrackerStoreLocationSync(cwd);
  } catch {
    // Not a Git checkout (or Git is unavailable): there is no repository-bound
    // store to retain or report, and that is not an uninstall failure.
    return { present: false, path: null, specs: null, tickets: null };
  }
  if ((await lstatOrNull(location.directory)) === null) {
    return { present: false, path: location.directory, specs: null, tickets: null };
  }
  try {
    const store = await loadLocalTrackerStore(location);
    const items = Object.values(store.items).map((file) => file.item);
    return {
      present: true,
      path: location.directory,
      specs: items.filter((item) => item.kind === "spec").length,
      tickets: items.filter((item) => item.kind === "ticket").length,
    };
  } catch {
    return { present: true, path: location.directory, specs: null, tickets: null };
  }
}

/**
 * `lstat` that maps absence to `null` instead of throwing, and never follows a
 * link. The purge has to tell "not there" from "there but not what I expected"
 * without ever resolving a symlink to whatever it points at.
 */
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** `true` for exactly the names this store layout is allowed to contain. */
function isKnownStoreEntry(name: string): boolean {
  return (
    name === LOCAL_TRACKER_STORE_FILENAME ||
    name === LOCAL_TRACKER_LOCK_FILENAME ||
    name === LOCAL_TRACKER_LOCK_GUARD_FILENAME ||
    TEMPORARY_PATTERN.test(name)
  );
}

export type LocalTrackerPurgeOutcome =
  | { purged: false; path: string; reason: "absent" | "no-store-document" }
  | { purged: true; path: string };

/**
 * Spec #190 / ticket #195 — the EXPLICIT, confirmed destruction of the Local
 * tracker history.
 *
 * Ordinary `uninstall` never calls this. It runs only behind an interactive
 * confirmation or the non-interactive confirmation flag, and it is the ONLY
 * operation in the runtime that deletes recorded tracker history.
 *
 * The validation is exhaustive and happens BEFORE the first unlink, because
 * every one of these refusals has to leave the store exactly as it was:
 *
 *   1. REPOSITORY IDENTITY. The store is bound to THIS repository's Git common
 *      directory. The directory must be a real directory at its canonical path:
 *      a symlinked store, or one that `realpath` resolves to some other path,
 *      means the bytes Poiesis is about to delete are not provably the ones this
 *      repository recorded. That is the "repository-identity mismatch" refusal.
 *   2. SYMLINKS. The store directory, `store.json`, `store.lock`,
 *      `store.lock.guard`, and every abandoned temporary must each be a
 *      non-symlinked regular file. A symlink anywhere refuses the WHOLE purge,
 *      because a later `rm --recursive` that met one would be deleting through
 *      it.
 *   3. UNKNOWN ENTRIES. Every name in the store directory must be one this
 *      layout issues. An unrecognised name is somebody else's data that happens
 *      to live under a Poiesis-chosen directory name, and deleting it "because
 *      it is under the store" is exactly the broad deletion this refuses.
 *   4. FOREIGN CONTENT. `store.json` must strictly validate as THIS tracker's
 *      document (`schema` + `provider` + the whole item map). A document another
 *      tool wrote, or a corrupt one, is refused rather than deleted.
 *   5. LOCKS. A `store.lock` or `store.lock.guard` means a process may be inside
 *      the read-decide-write critical section right now. This module never
 *      reclaims a guard at any age (see the module header), and destroying the
 *      store under a live holder would lose a committed write, so both refuse.
 *
 * Nothing else is ever a target. This function names one directory; it has no
 * parameter through which a caller could widen it, and it never touches Git
 * objects, refs, remotes, pull/merge requests, releases, or deployment state —
 * none of which live in this store and none of which this module can reach.
 */
export async function purgeValidatedLocalTrackerHistory(cwd: string): Promise<LocalTrackerPurgeOutcome> {
  const location = resolveLocalTrackerStoreLocationSync(cwd);
  const directory = await lstatOrNull(location.directory);
  if (directory === null) return { purged: false, path: location.directory, reason: "absent" };
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw unsafe(location.directory, "the store directory is a symlink or not a directory", {
      kind: directory.isSymbolicLink() ? "symlink" : "non-directory",
    });
  }
  // Repository-identity proof: the store must resolve to the exact canonical
  // path under THIS repository's canonical Git common directory.
  const canonicalGitCommonDir = realpathSync(location.gitCommonDir);
  const canonicalDirectory = realpathSync(location.directory);
  if (
    canonicalDirectory !== location.directory ||
    dirname(canonicalDirectory) !== canonicalGitCommonDir ||
    basename(canonicalDirectory) !== LOCAL_TRACKER_STORE_DIRECTORY
  ) {
    throw new PoiesisError(
      "LOCAL_TRACKER_HISTORY_IDENTITY_MISMATCH",
      "Refusing to purge Local tracker history: the store does not resolve to this repository's canonical store path",
      { path: location.directory, resolved: canonicalDirectory, gitCommonDir: canonicalGitCommonDir },
    );
  }

  const entries = await readdir(location.directory);
  const unknownEntries = entries.filter((entry) => !isKnownStoreEntry(entry)).sort();
  if (unknownEntries.length > 0) {
    throw new PoiesisError(
      "LOCAL_TRACKER_HISTORY_UNSAFE",
      "Refusing to purge Local tracker history: the store directory holds entries this store layout never issues",
      { path: location.directory, unknownEntries },
    );
  }
  for (const entry of entries) {
    const details = await lstatOrNull(join(location.directory, entry));
    if (details === null) continue;
    if (details.isSymbolicLink() || !details.isFile()) {
      throw unsafe(location.directory, `the store entry ${entry} is a symlink or not a regular file`, {
        entry,
        kind: details.isSymbolicLink() ? "symlink" : "non-regular",
      });
    }
  }

  const lockNames = entries.filter(
    (entry) => entry === LOCAL_TRACKER_LOCK_FILENAME || entry === LOCAL_TRACKER_LOCK_GUARD_FILENAME,
  );
  if (lockNames.length > 0) {
    throw new PoiesisError(
      "LOCAL_TRACKER_HISTORY_LOCKED",
      "Refusing to purge Local tracker history: the store lock is present, so a tracker operation may be in flight",
      { path: location.directory, lockNames },
    );
  }

  const storeDocument = await lstatOrNull(location.storePath);
  if (storeDocument === null) {
    // No document means no recorded history to destroy. Poiesis does not delete
    // the directory to "tidy up": without a validated document it cannot prove
    // the remaining bytes are its own, which is the same rule every other
    // refusal here applies.
    return { purged: false, path: location.directory, reason: "no-store-document" };
  }
  // Throws `INVALID_LOCAL_TRACKER_STORE` / `LOCAL_TRACKER_STORE_TOO_LARGE` for
  // foreign or corrupt content. Either way nothing has been deleted.
  parseLocalTrackerStore(await readStoreBytesBounded(location.storePath));

  await rm(location.directory, { recursive: true, force: true });
  return { purged: true, path: location.directory };
}

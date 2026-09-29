import { constants } from "node:fs";
import { access, link, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readUtf8(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/**
 * The permission bits the destination already carries, or `null` when the
 * destination does not exist yet.
 *
 * Ticket #137: `rename` carries the temporary file's mode onto the
 * destination, so creating the temporary at a fixed 0600 silently narrowed
 * every Author file Poiesis rewrote. Git does not track read/write bits, so
 * the divergence from a fresh clone was invisible to `git status`.
 */
async function existingFileMode(path: string): Promise<number | null> {
  try {
    const stats = await lstat(path);
    // Only a regular file has a meaningful mode to carry over. A symlink or
    // directory destination is rejected by the callers' own ownership checks;
    // returning null here keeps the temporary at its safe 0600 default rather
    // than guessing.
    if (!stats.isFile()) return null;
    return stats.mode & 0o777;
  } catch {
    return null;
  }
}

async function prepareTemporaryFile(path: string, content: string | Buffer): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  // Preserve the destination's permission bits when it already exists, including
  // a mode NARROWER than 0600 (a deliberately private file must stay private).
  // Only a genuinely new file gets the 0600 default, so an unwritten temporary
  // is never readable by another user.
  //
  // The mode is applied through `open`, so the process umask still masks it:
  // under umask 022 a 0664 destination lands at 0644. That is intentional and
  // is the safe direction. The alternative - an explicit `chmod` on the
  // temporary to force the exact bits - would put the file at its final mode
  // while it still exists under a guessable name, reopening the exposure the
  // 0600 default exists to prevent. Under the standard 022 umask the ordinary
  // 0644 and deliberately-private 0600 cases are both exact.
  const destinationMode = await existingFileMode(path);
  const temporaryMode = destinationMode ?? 0o600;
  try {
    const handle = await open(temporary, "wx", temporaryMode);
    try {
      // When content is a Buffer, write it as raw bytes (the encoding
      // argument is ignored). When content is a string, encode as utf8.
      // This lets callers restore exact preimage bytes without lossy
      // string conversions or newline normalization.
      await handle.writeFile(content as string | Buffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return temporary;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  await atomicWriteGuarded(path, content, async () => undefined);
}

/** Prepare and fsync replacement bytes, then run the guard immediately before rename. */
export async function atomicWriteGuarded(
  path: string,
  content: string | Buffer,
  preReplaceGuard: () => void | Promise<void>,
): Promise<void> {
  const temporary = await prepareTemporaryFile(path, content);
  try {
    await preReplaceGuard();
    await rename(temporary, path);
  } catch (error) {
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function atomicCreate(path: string, content: string | Buffer): Promise<void> {
  const temporary = await prepareTemporaryFile(path, content);
  try {
    await link(temporary, path);
  } catch (error) {
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

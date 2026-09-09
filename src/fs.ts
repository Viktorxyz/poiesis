import { constants } from "node:fs";
import { access, link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
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

async function prepareTemporaryFile(path: string, content: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
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

export async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = await prepareTemporaryFile(path, content);
  try {
    await rename(temporary, path);
  } catch (error) {
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function atomicCreate(path: string, content: string): Promise<void> {
  const temporary = await prepareTemporaryFile(path, content);
  try {
    await link(temporary, path);
  } catch (error) {
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

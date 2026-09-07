import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function hashFile(path: string): Promise<string> {
  return hashContent(await readFile(path));
}

export async function hashDirectory(path: string): Promise<string> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  await walk(path);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(path, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function pathKind(path: string): Promise<"file" | "directory" | "other"> {
  const details = await stat(path);
  if (details.isFile()) return "file";
  if (details.isDirectory()) return "directory";
  return "other";
}

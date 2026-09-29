
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWrite, atomicWriteGuarded } from "../src/fs.js";

/**
 * Ticket #137: an atomic replace must not narrow or widen the destination's
 * permission bits. `rename` carries the temporary file's mode onto the
 * destination, so the temporary has to be created with the destination's own
 * mode.
 */
describe("ticket #137 - atomic replace preserves destination permissions", () => {
  it("leaves an existing 0644 file at 0644", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-mode-0644-"));
    try {
      const file = join(dir, "file");
      await writeFile(file, "before");
      await chmod(file, 0o644);
      await atomicWrite(file, "after");
      const stats = await import("node:fs/promises").then((m) => m.stat(file));
      expect(stats.mode & 0o777).toBe(0o644);
      expect(await readFile(file, "utf8")).toBe("after");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not widen a deliberately private 0600 file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-mode-0600-"));
    try {
      const file = join(dir, "file");
      await writeFile(file, "before");
      await chmod(file, 0o600);
      await atomicWrite(file, "after");
      const stats = await import("node:fs/promises").then((m) => m.stat(file));
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never becomes MORE permissive than the destination had", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-mode-umask-"));
    try {
      const file = join(dir, "file");
      await writeFile(file, "before");
      await chmod(file, 0o666);
      await atomicWrite(file, "after");
      const stats = await import("node:fs/promises").then((m) => m.stat(file));
      // The umask may narrow the result, never widen it. Widening would be the
      // actual regression: Poiesis must not hand an Author file MORE access
      // than it already had.
      expect(stats.mode & 0o777 & ~0o666).toBe(0);
      expect(stats.mode & 0o777).toBe((0o666 & ~process.umask()) & 0o777);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates a genuinely new file as 0600, never world-readable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-mode-new-"));
    try {
      const file = join(dir, "brand-new");
      await atomicWrite(file, "content");
      const stats = await import("node:fs/promises").then((m) => m.stat(file));
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("applies the same rule through the guarded variant used by the OpenCode projection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-mode-guarded-"));
    try {
      const file = join(dir, "file");
      await writeFile(file, "before");
      await chmod(file, 0o644);
      let guardRan = false;
      await atomicWriteGuarded(file, "after", () => {
        guardRan = true;
      });
      expect(guardRan).toBe(true);
      const stats = await import("node:fs/promises").then((m) => m.stat(file));
      expect(stats.mode & 0o777).toBe(0o644);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not clobber a foreign replacement when the guard rejects the write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poiesis-mode-foreign-"));
    try {
      const file = join(dir, "file");
      await writeFile(file, "original");
      await chmod(file, 0o644);
      await expect(
        atomicWriteGuarded(file, "replacement", () => {
          throw new Error("identity drift");
        }),
      ).rejects.toThrow();
      // The foreign bytes must survive, and so must their mode.
      expect(await readFile(file, "utf8")).toBe("original");
      const stats = await import("node:fs/promises").then((m) => m.stat(file));
      expect(stats.mode & 0o777).toBe(0o644);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

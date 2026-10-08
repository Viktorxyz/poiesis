/**
 * Spec #139 / ticket #156 — the bounded, synchronous Git common-dir discovery
 * seam, and the platform-correct installation-root derivation.
 *
 * Two defects motivated this ticket, and both are silent:
 *
 *   1. THE DISCOVERY HAD NO BOUND AND NO TYPED FAILURE. Resolving the Git
 *      common directory ran `execFileSync` with Node's DEFAULT timeout (no
 *      timeout at all) and Node's DEFAULT output cap, and every one of its five
 *      distinguishable failures — the query could not start, it ran past its
 *      bound, it exited nonzero, it printed more than the cap, or it printed
 *      something that is not a path — collapsed into ONE code whose only extra
 *      evidence was the caught exception's `message`. An `execFileSync`
 *      exception message is assembled from the command line, the child's
 *      stderr, and the absolute paths around it, so the one field meant to help
 *      an operator was also the one field that could carry a credential a
 *      hostile repository printed, and a hang had no code at all to branch on.
 *
 *   2. THE INSTALLATION ROOT WAS DERIVED WITH A POSIX-ONLY REGEX. The primary
 *      checkout that owns an installation was found by stripping a trailing `/`
 *      and then the last `/`-delimited segment. On a POSIX host that is
 *      correct; on a Windows host `C:\primary\.git` contains no `/` at all, so
 *      the derivation returned its own input and a linked worktree resolved the
 *      INSTALLATION ROOT to itself — the runtime identity and lifecycle-policy
 *      guards then read the worktree's config instead of the primary's, which
 *      is exactly the authority split the derivation exists to prevent. The fix
 *      is the platform's own `dirname` semantics, reached through an injectable
 *      flavor so the Windows answer is evidence on a Linux host instead of a
 *      claim.
 *
 * The seam stays SYNCHRONOUS. `TrackerAdapter.project` is a synchronous readonly
 * property and `createTrackerAdapter` returns synchronously, so the store
 * location has to be resolvable synchronously; an async seam would either break
 * that contract or force a second, divergent implementation.
 */
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackerAdapter } from "../src/adapters.js";
import { PoiesisError } from "../src/errors.js";
import {
  GIT_COMMON_DIR_MAX_OUTPUT_BYTES,
  GIT_COMMON_DIR_REFUSALS,
  GIT_COMMON_DIR_TIMEOUT_MS,
  discoverGitCommonDir,
  setGitCommonDirProbeForTest,
  type GitCommonDirProbe,
  type GitCommonDirProbeResult,
} from "../src/git-common-dir.js";
import { LOCAL_TRACKER_STORE_DIRECTORY, resolveLocalTrackerStoreLocation } from "../src/local-tracker.js";
import {
  autoResolveConfigDefaults,
  deriveInstallationRoot,
  inspectTracker,
  primaryCheckoutOfCommonDir,
  resolveInstallationRoot,
} from "../src/maintenance.js";
import { posixPathFlavor, win32PathFlavor } from "../src/path-flavor.js";
import { run } from "../src/process.js";
import { createTestRepository, type TestRepository } from "./helpers.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  setGitCommonDirProbeForTest(null);
  await Promise.all(repositories.splice(0).map((repository) => rm(repository.parent, { recursive: true, force: true })));
});

async function newRepository(): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  return repository;
}

/** A probe that reports `stdout` verbatim and records the invocation it saw. */
function reportingProbe(stdout: string): {
  probe: GitCommonDirProbe;
  calls: Array<{ repoRoot: string; timeoutMs: number; maxOutputBytes: number }>;
} {
  const calls: Array<{ repoRoot: string; timeoutMs: number; maxOutputBytes: number }> = [];
  const probe: GitCommonDirProbe = (invocation) => {
    calls.push({ ...invocation });
    return { outcome: "reported", stdout };
  };
  return { probe, calls };
}

function refusalOf(call: () => unknown): PoiesisError {
  try {
    call();
  } catch (error) {
    if (error instanceof PoiesisError) return error;
    throw error;
  }
  throw new Error("the call was expected to refuse with a typed PoiesisError");
}

/** Every string a refusal could carry: its message and every detail value. */
function refusalText(error: PoiesisError): string {
  return `${error.message} ${JSON.stringify(error.details)}`;
}

async function newPlainDirectory(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "poiesis-not-a-repo-"));
  repositories.push({ parent, root: join(parent, "plain"), remote: "", fixtures: "", baseSha: "" });
  await mkdir(join(parent, "plain"));
  return join(parent, "plain");
}

describe("the Git common-dir discovery seam is bounded, synchronous, and typed", () => {
  it("declares explicit finite bounds and hands both to the probe", () => {
    expect(Number.isSafeInteger(GIT_COMMON_DIR_TIMEOUT_MS)).toBe(true);
    expect(GIT_COMMON_DIR_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isSafeInteger(GIT_COMMON_DIR_MAX_OUTPUT_BYTES)).toBe(true);
    expect(GIT_COMMON_DIR_MAX_OUTPUT_BYTES).toBeGreaterThan(0);

    const { probe, calls } = reportingProbe("/srv/primary/.git\n");
    setGitCommonDirProbeForTest(probe);
    discoverGitCommonDir("/srv/primary");

    expect(calls).toEqual([
      {
        repoRoot: "/srv/primary",
        timeoutMs: GIT_COMMON_DIR_TIMEOUT_MS,
        maxOutputBytes: GIT_COMMON_DIR_MAX_OUTPUT_BYTES,
      },
    ]);
  });

  it("resolves an absolute report verbatim and a relative report against the invocation repo root", () => {
    setGitCommonDirProbeForTest(reportingProbe("/srv/primary/.git\n").probe);
    expect(discoverGitCommonDir("/elsewhere/ignored")).toBe(resolve("/srv/primary/.git"));

    // A primary checkout reports `.git` relative to the directory the query ran
    // in. Resolving it against the PROCESS cwd instead of the invocation root
    // would place the store outside the repository the caller named.
    setGitCommonDirProbeForTest(reportingProbe(".git\n").probe);
    expect(resolve(discoverGitCommonDir("/srv/primary"))).toBe(resolve("/srv/primary", ".git"));

    // A nested invocation root still anchors at the root it was given, so a
    // `../.git` report lands on the checkout above the leaf that asked.
    setGitCommonDirProbeForTest(reportingProbe("../.git\n").probe);
    expect(resolve(discoverGitCommonDir("/srv/primary/packages/app"))).toBe(
      resolve("/srv/primary/packages/app", "../.git"),
    );
  });

  it("normalizes a report that arrives with redundant separators", () => {
    setGitCommonDirProbeForTest(reportingProbe("/srv//primary/./nested/../.git\n").probe);
    expect(resolve(discoverGitCommonDir("/ignored"))).toBe(resolve("/srv/primary/.git"));
  });

  it("refuses an oversized report that arrived inside a well-formed single line", () => {
    // The transport's own overflow error is not the only way to exceed the
    // ceiling: a transport that returns a large report without complaining
    // must still be refused, or the bound is the transport's promise rather
    // than this seam's contract.
    const huge = `/${"a".repeat(GIT_COMMON_DIR_MAX_OUTPUT_BYTES * 4)}/.git\n`;
    setGitCommonDirProbeForTest(reportingProbe(huge).probe);
    const error = refusalOf(() => discoverGitCommonDir("/srv/primary"));
    expect(error.code).toBe(GIT_COMMON_DIR_REFUSALS.oversized);
    expect(error.details).toMatchObject({
      reason: "oversized",
      maxOutputBytes: GIT_COMMON_DIR_MAX_OUTPUT_BYTES,
    });
    expect(error.details).not.toHaveProperty("stdout");
  });

  it("accepts a report exactly at the ceiling and refuses one byte more", () => {
    // The ceiling is measured on the bytes the TRANSPORT hands over, so the
    // trailing newline counts: the accepted report below is exactly
    // `GIT_COMMON_DIR_MAX_OUTPUT_BYTES` bytes and the refused one is that plus
    // a single byte. An off-by-one here would either reject a legitimate path
    // or admit an unbounded one, so the boundary is asserted rather than
    // assumed.
    const atCeiling = `/${"a".repeat(GIT_COMMON_DIR_MAX_OUTPUT_BYTES - 2)}`;
    expect(Buffer.byteLength(`${atCeiling}\n`, "utf8")).toBe(GIT_COMMON_DIR_MAX_OUTPUT_BYTES);
    setGitCommonDirProbeForTest(reportingProbe(`${atCeiling}\n`).probe);
    expect(resolve(discoverGitCommonDir("/ignored"))).toBe(resolve(atCeiling));

    setGitCommonDirProbeForTest(reportingProbe(`${atCeiling}a\n`).probe);
    expect(refusalOf(() => discoverGitCommonDir("/ignored")).code).toBe(GIT_COMMON_DIR_REFUSALS.oversized);
  });

  it("refuses a query that could not start, with no exception text", () => {
    setGitCommonDirProbeForTest((): GitCommonDirProbeResult => ({ outcome: "spawn" }));
    const error = refusalOf(() => discoverGitCommonDir("/srv/primary"));
    expect(error.code).toBe(GIT_COMMON_DIR_REFUSALS.spawn);
    expect(error.details).toMatchObject({ reason: "spawn", repoRoot: resolve("/srv/primary") });
    expect(refusalText(error)).not.toMatch(/ENOENT|syscall|spawnSync|executable/i);
  });

  it("refuses a query that ran past its finite timeout", () => {
    setGitCommonDirProbeForTest((): GitCommonDirProbeResult => ({ outcome: "timeout" }));
    const error = refusalOf(() => discoverGitCommonDir("/srv/primary"));
    expect(error.code).toBe(GIT_COMMON_DIR_REFUSALS.timeout);
    expect(error.details).toMatchObject({ reason: "timeout", timeoutMs: GIT_COMMON_DIR_TIMEOUT_MS });
  });

  it("refuses a query that exited nonzero, reporting only the status values", () => {
    setGitCommonDirProbeForTest((): GitCommonDirProbeResult => ({ outcome: "nonzero", exitCode: 128, signal: null }));
    const error = refusalOf(() => discoverGitCommonDir("/srv/primary"));
    expect(error.code).toBe(GIT_COMMON_DIR_REFUSALS.nonzero);
    expect(error.details).toMatchObject({ reason: "nonzero", exitCode: 128, signal: null });
  });

  it("refuses output past the max-output bound and reports only the byte count", () => {
    setGitCommonDirProbeForTest((): GitCommonDirProbeResult => ({ outcome: "oversized", observedBytes: 98_765 }));
    const error = refusalOf(() => discoverGitCommonDir("/srv/primary"));
    expect(error.code).toBe(GIT_COMMON_DIR_REFUSALS.oversized);
    expect(error.details).toMatchObject({
      reason: "oversized",
      observedBytes: 98_765,
      maxOutputBytes: GIT_COMMON_DIR_MAX_OUTPUT_BYTES,
    });
  });

  it("refuses output that is not exactly one path", () => {
    for (const stdout of ["", "   \n\t\n", "/srv/primary/.git\n/srv/other/.git\n"]) {
      setGitCommonDirProbeForTest(reportingProbe(stdout).probe);
      const error = refusalOf(() => discoverGitCommonDir("/srv/primary"));
      expect(error.code, `must refuse ${JSON.stringify(stdout)}`).toBe(GIT_COMMON_DIR_REFUSALS.malformed);
      expect(error.details).toMatchObject({ reason: "malformed", reportedLineCount: expect.any(Number) });
    }
  });

  it("refuses a report carrying control bytes rather than resolving it into a path", () => {
    for (const stdout of ["/srv/primary/.git\u0000/elsewhere", "/srv/primary/.git\n\r\n/srv/other"]) {
      setGitCommonDirProbeForTest(reportingProbe(stdout).probe);
      expect(refusalOf(() => discoverGitCommonDir("/srv/primary")).code).toBe(GIT_COMMON_DIR_REFUSALS.malformed);
    }
  });

  it("retains no process text on any refusal, including a credential the report itself carried", () => {
    // A remote URL is exactly the shape that carries a credential, and a
    // multi-line report is exactly the shape that makes Git print one. The
    // refusal states the shape as a COUNT and keeps the bytes out.
    setGitCommonDirProbeForTest(
      reportingProbe("/srv/primary/.git\nhttps://deploy:hunter2@example.invalid/repo.git\n").probe,
    );
    const error = refusalOf(() => discoverGitCommonDir("/srv/primary"));
    expect(error.details).toMatchObject({ reportedLineCount: 2 });
    expect(refusalText(error)).not.toContain("hunter2");
    expect(refusalText(error)).not.toContain("example.invalid");
    for (const forbidden of ["command", "args", "stdout", "stderr", "cause", "error", "message"]) {
      expect(Object.keys(error.details), `must not retain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("carries no command, args, or process output from the real transport's own failure", () => {
    // The default transport against a real directory that is not a repository:
    // real Git exits nonzero and writes `fatal: ...` to stderr, so this proves
    // the PRODUCTION path — not only an injected probe — withholds that text.
    const plain = newPlainDirectory();
    setGitCommonDirProbeForTest(null);
    return plain.then((root) => {
      const error = refusalOf(() => discoverGitCommonDir(root));
      expect(error.code).toBe(GIT_COMMON_DIR_REFUSALS.nonzero);
      expect(error.details).toMatchObject({ exitCode: 128 });
      expect(refusalText(error)).not.toMatch(/fatal|not a git repository|rev-parse|\.git/i);
    });
  });
});

describe("the local tracker resolves its store through the bounded seam", () => {
  it("keeps the store factory synchronous and refuses a refused discovery synchronously", async () => {
    const repository = await newRepository();
    setGitCommonDirProbeForTest(null);

    // `TrackerAdapter.project` is a synchronous readonly property, so the
    // location is resolved during construction — not on first await.
    const adapter = createTrackerAdapter({ provider: "local" }, repository.root);
    expect(adapter.provider).toBe("local");
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    expect(adapter.project).toBe(location.storePath);

    setGitCommonDirProbeForTest((): GitCommonDirProbeResult => ({ outcome: "timeout" }));
    // A SYNCHRONOUS throw, not a rejected promise: the factory is not `async`
    // and must not be made `async` to accommodate the seam.
    let thrown: unknown;
    try {
      createTrackerAdapter({ provider: "local" }, repository.root);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PoiesisError);
    expect((thrown as PoiesisError).code).toBe(GIT_COMMON_DIR_REFUSALS.timeout);
  });

  it("anchors a relative common-dir report at the repository root, not at the process cwd", async () => {
    const repository = await newRepository();
    const reported = (await run("git", ["rev-parse", "--git-common-dir"], { cwd: repository.root })).stdout;
    expect(reported.trim()).toBe(".git");

    setGitCommonDirProbeForTest(reportingProbe(reported).probe);
    const location = await resolveLocalTrackerStoreLocation(repository.root);
    const commonDir = await realpath(resolve(repository.root, reported));
    expect(location.directory).toBe(join(commonDir, LOCAL_TRACKER_STORE_DIRECTORY));
  });

  it("shares one store between a primary checkout and a linked worktree", async () => {
    const repository = await newRepository();
    const worktree = join(repository.parent, "linked");
    await run("git", ["worktree", "add", "--quiet", "--no-track", "-b", "poiesis/local-linked", worktree], {
      cwd: repository.root,
    });
    setGitCommonDirProbeForTest(null);

    // A linked worktree's common dir is ABSOLUTE and points at the primary
    // checkout's `.git`, which is the authority the store is canonical to.
    expect(await resolveLocalTrackerStoreLocation(worktree)).toEqual(
      await resolveLocalTrackerStoreLocation(repository.root),
    );
  });

  it("creates nothing at all when the discovery is refused", async () => {
    const repository = await newRepository();
    setGitCommonDirProbeForTest(
      reportingProbe("/srv/other/.git\nhttps://deploy:hunter2@example.invalid/repo.git\n").probe,
    );
    const error = refusalOf(() => discoverGitCommonDir(repository.root));
    expect(error.code).toBe(GIT_COMMON_DIR_REFUSALS.malformed);
    expect(refusalText(error)).not.toContain("hunter2");

    // The store is created lazily by a mutation, never by a location query, so
    // a refused query leaves the common directory exactly as it found it.
    expect(existsSync(join(repository.root, ".git", LOCAL_TRACKER_STORE_DIRECTORY))).toBe(false);
  });
});

describe("the lifecycle preflight reaches the same store through the bounded seam", () => {
  it("verifies a local tracker with no probe override and refuses a refused discovery with the same code", async () => {
    const repository = await newRepository();
    const { config } = await autoResolveConfigDefaults(repository.root, {
      schema: 1 as const,
      models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
      repository: { remote: "origin", integrationBranch: "main" },
      tracker: { provider: "local" },
      verification: { commands: ["test -f README.md"] },
    });
    setGitCommonDirProbeForTest(null);
    expect(await inspectTracker(repository.root, config)).toEqual({ mode: "verified" });

    setGitCommonDirProbeForTest((): GitCommonDirProbeResult => ({ outcome: "spawn" }));
    await expect(inspectTracker(repository.root, config)).rejects.toMatchObject({
      code: GIT_COMMON_DIR_REFUSALS.spawn,
    });
  });
});

describe("the installation root is derived with the platform's own dirname semantics", () => {
  it("derives the primary checkout from a POSIX common directory", () => {
    expect(primaryCheckoutOfCommonDir("/srv/primary/.git", posixPathFlavor)).toBe("/srv/primary");
    expect(primaryCheckoutOfCommonDir("/srv/primary/.git/", posixPathFlavor)).toBe("/srv/primary");
    expect(primaryCheckoutOfCommonDir("/.git", posixPathFlavor)).toBe("/");
    expect(primaryCheckoutOfCommonDir("/srv/nested/deeper/.git", posixPathFlavor)).toBe("/srv/nested/deeper");
  });

  it("derives the primary checkout from a Windows common directory", () => {
    // A Windows common directory contains no `/`, so the stripped regex this
    // replaces answered with its own input here and handed a linked worktree
    // its own root as the installation root.
    expect(primaryCheckoutOfCommonDir("C:\\primary\\.git", win32PathFlavor)).toBe("C:\\primary");
    expect(primaryCheckoutOfCommonDir("C:\\primary\\.git\\", win32PathFlavor)).toBe("C:\\primary");
    expect(primaryCheckoutOfCommonDir("C:\\.git", win32PathFlavor)).toBe("C:\\");
    expect(primaryCheckoutOfCommonDir("\\\\server\\share\\primary\\.git", win32PathFlavor)).toBe(
      "\\\\server\\share\\primary",
    );
  });

  it("refuses to derive a parent from a filesystem root or a relative report", () => {
    expect(primaryCheckoutOfCommonDir("/", posixPathFlavor)).toBeNull();
    expect(primaryCheckoutOfCommonDir("C:\\", win32PathFlavor)).toBeNull();
    expect(primaryCheckoutOfCommonDir(".git", posixPathFlavor)).toBeNull();
  });

  it("keeps a primary checkout as the installation root and follows a linked worktree to its primary", () => {
    const host = posixPathFlavor;
    // A primary checkout: `--absolute-git-dir` and `--git-common-dir` are the
    // same path, so the checkout itself owns the installation.
    expect(deriveInstallationRoot("/srv/primary", ["/srv/primary/.git", "/srv/primary/.git"], host)).toBe(
      "/srv/primary",
    );
    // A linked worktree: the common dir is the primary checkout's `.git`.
    expect(
      deriveInstallationRoot("/srv/linked", ["/srv/primary/.git/worktrees/linked", "/srv/primary/.git"], host),
    ).toBe("/srv/primary");
    // A relative report, and reports that arrive with a trailing separator.
    expect(deriveInstallationRoot("/srv/primary", ["/srv/primary/.git", ".git"], host)).toBe("/srv/primary");
    expect(
      deriveInstallationRoot("/srv/linked", ["/srv/primary/.git/worktrees/linked/", "/srv/primary/.git/"], host),
    ).toBe("/srv/primary");
    // A common directory that is a filesystem root, and a report too short to
    // name a common directory at all: both refuse to answer, so the invocation
    // root stands rather than a guess.
    expect(deriveInstallationRoot("/srv/linked", ["/srv/primary/.git", "/"], host)).toBe("/srv/linked");
    expect(deriveInstallationRoot("/srv/linked", ["/srv/primary/.git"], host)).toBe("/srv/linked");
  });

  it("answers the same way for a Windows linked worktree as for a POSIX one", () => {
    expect(
      deriveInstallationRoot(
        "C:\\linked",
        ["C:\\primary\\.git\\worktrees\\linked", "C:\\primary\\.git"],
        win32PathFlavor,
      ),
    ).toBe("C:\\primary");
    expect(
      deriveInstallationRoot("C:\\primary", ["C:\\primary\\.git", "C:\\primary\\.git"], win32PathFlavor),
    ).toBe("C:\\primary");
  });

  it("keeps the real primary and linked-worktree authority on this host", async () => {
    const repository = await newRepository();
    expect(await resolveInstallationRoot(repository.root)).toBe(resolve(repository.root));

    const worktree = join(repository.parent, "linked");
    await run("git", ["worktree", "add", "--quiet", "--no-track", "-b", "poiesis/local-linked", worktree], {
      cwd: repository.root,
    });
    expect(await resolveInstallationRoot(worktree)).toBe(resolve(repository.root));
  });
});

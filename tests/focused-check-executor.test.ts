/**
 * Spec #168 / ticket #172 — the ONE scope-aware check executor.
 *
 * `executeCheck` in `src/focused-check.ts` supports both scopes the Spec
 * names:
 *
 *   - `focused` — explicit commands, a Poiesis-OWNED (and possibly dirty)
 *     candidate workspace, bounded per-command evidence, a deterministic
 *     action fingerprint, a deterministic failure classification, and NO
 *     lifecycle authority whatsoever: a focused result can never carry a
 *     verification receipt or a proof, and running it writes no receipt.
 *   - `proof` — the exact clean candidate and the installation's configured
 *     plan, delegated unchanged to `verify` so the #171 exact-candidate
 *     verification receipt and every existing fail-closed code stay intact.
 *
 * Executed through ticket #170 managed process execution: a focused command
 * that leaks a descendant, times out, or is cancelled is still settled
 * before the result is returned.
 */
import { readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { workspacePrepare, type WorkspaceIdentity } from "../src/git.js";
import { init } from "../src/maintenance.js";
import { run } from "../src/process.js";
import {
  executeCheck,
  type CheckProgressEvent,
  type FocusedCheckResult,
  type ProofCheckResult,
  type ResourcePressureSample,
} from "../src/focused-check.js";
import { VERIFICATION_RECEIPT_DIRECTORY } from "../src/verification-receipt.js";
import {
  createTestRepository,
  describeManagedExecution,
  itManagedExecution,
  testConfig,
  type TestRepository,
} from "./helpers.js";
import { installFakeOpenCode, type FakeOpenCodeEnvironment } from "./fake-opencode.js";

const CALM: ResourcePressureSample = {
  loadAverage1m: 0.1,
  parallelism: 8,
  freeMemoryBytes: 8 * 1024 ** 3,
  totalMemoryBytes: 16 * 1024 ** 3,
};

const SATURATED: ResourcePressureSample = {
  loadAverage1m: 40,
  parallelism: 8,
  freeMemoryBytes: 8 * 1024 ** 3,
  totalMemoryBytes: 16 * 1024 ** 3,
};

let repository: TestRepository;
let env: FakeOpenCodeEnvironment;
let commonDir: string;
let specCounter = 0;
const bare: string[] = [];

beforeAll(async () => {
  env = await installFakeOpenCode();
  repository = await createTestRepository();
  await init(
    repository.root,
    { ...testConfig(repository), verification: { commands: ["printf primary-proof-plan"] } },
    { skipSkills: true, allowFixtureAdapters: true },
  );
  // `git rev-parse --git-common-dir` answers relative to the cwd it ran in,
  // so the receipt store is only findable once it is resolved against the
  // repository root, exactly as `src/git.ts` resolves it.
  const reported = (await run("git", ["rev-parse", "--git-common-dir"], { cwd: repository.root })).stdout;
  commonDir = await realpath(isAbsolute(reported) ? reported : resolve(repository.root, reported));
}, 120_000);

afterAll(async () => {
  env?.restore();
  for (const parent of bare.splice(0)) await rm(parent, { recursive: true, force: true });
  if (repository !== undefined) await rm(repository.parent, { recursive: true, force: true });
});

async function ownedCandidate(label: string): Promise<WorkspaceIdentity> {
  specCounter += 1;
  const specId = `spec-focused-${label}-${specCounter}`;
  return await workspacePrepare({
    cwd: repository.root,
    remote: "origin",
    integrationBranch: "main",
    branch: `poiesis/${specId}`,
    specId,
  });
}

async function receiptsExist(): Promise<boolean> {
  try {
    await stat(join(commonDir, VERIFICATION_RECEIPT_DIRECTORY));
    return true;
  } catch {
    return false;
  }
}

describe("focused scope (Spec #168 / ticket #172)", () => {
  itManagedExecution("runs explicit commands in an owned candidate and creates no proof of any kind", async () => {
    const candidate = await ownedCandidate("clean");
    const result = await executeCheck({
      scope: "focused",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      commands: ["printf focused-one", "test -f README.md"],
    });

    expect(result.scope).toBe("focused");
    expect(result.authoritative).toBe(false);
    expect(result.outcome).toBe("passed");
    expect(result.classification).toBeNull();
    expect(result.state).toMatchObject({
      workspace: await realpath(candidate.path),
      ownershipId: candidate.ownershipId,
      head: candidate.headSha,
      dirty: false,
    });
    // A focused result is structurally incapable of carrying proof.
    const focused = result as FocusedCheckResult;
    const noProof: null = focused.proof;
    const noVerification: null = focused.verification;
    void noProof;
    void noVerification;

    expect(focused.commands).toHaveLength(2);
    expect(focused.commands[0]).toMatchObject({
      index: 0,
      command: "printf focused-one",
      status: "passed",
      classification: "passed",
      exitCode: 0,
      signal: null,
      timeoutState: "not-timed-out",
      stdout: "focused-one",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      outputTruncated: false,
    });
    expect(focused.commands[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(focused.commands[0]?.timeoutMs).toBeGreaterThan(0);
    expect(focused.commands[0]?.pressure).toMatchObject({ samples: 2, pressured: expect.any(Boolean) });
    expect(await receiptsExist()).toBe(false);
  }, 60_000);

  itManagedExecution("runs in a dirty owned workspace and records the dirty state instead of failing", async () => {
    const candidate = await ownedCandidate("dirty");
    await writeFile(join(candidate.path, "README.md"), "in-progress ticket work\n", "utf8");
    await writeFile(join(candidate.path, "untracked.txt"), "scratch\n", "utf8");

    const result = await executeCheck({
      scope: "focused",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      commands: ["test -f untracked.txt"],
    });

    expect(result.outcome).toBe("passed");
    expect(result.state.dirty).toBe(true);
    expect(result.state.changedFiles.sort()).toEqual(["README.md", "untracked.txt"]);
    expect(result.classification).toBeNull();
  }, 60_000);

  it("requires at least one explicit command", async () => {
    const candidate = await ownedCandidate("no-commands");
    await expect(
      executeCheck({ scope: "focused", cwd: candidate.path, ownershipId: candidate.ownershipId, commands: [] }),
    ).rejects.toMatchObject({ code: "NO_FOCUSED_CHECK_COMMANDS" });
  }, 60_000);

  it("fails closed on a workspace Poiesis does not own", async () => {
    const foreign = join(repository.parent, `foreign-focused-${Date.now()}`);
    await run("git", ["worktree", "add", "--detach", "--quiet", foreign, repository.baseSha], {
      cwd: repository.root,
    });

    await expect(
      executeCheck({ scope: "focused", cwd: foreign, commands: ["true"] }),
    ).rejects.toMatchObject({ code: "WORKSPACE_OWNERSHIP_UNKNOWN" });
  }, 60_000);

  itManagedExecution("bounds output and reports explicit truncation metadata", async () => {
    const candidate = await ownedCandidate("truncation");
    const result = await executeCheck({
      scope: "focused",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      commands: ["yes 0123456789 | head -400"],
      outputLimit: 500,
    });

    expect(result.commands?.[0]).toMatchObject({
      status: "passed",
      stdoutTruncated: true,
      stderrTruncated: false,
      outputTruncated: true,
    });
    const stdout = result.commands?.[0]?.stdout ?? "";
    expect(stdout.length).toBeLessThan(700);
    expect(stdout).toMatch(/\.\.\. truncated \d+ bytes$/);
    // 400 lines of 11 bytes cannot survive a 500-byte bound, so the retained
    // prefix plus the truncation notice must be far shorter than the raw run.
    expect(stdout.startsWith("0123456789\n")).toBe(true);
  }, 60_000);

  itManagedExecution("classifies a non-zero exit as a non-zero command failure without throwing or retrying", async () => {
    const candidate = await ownedCandidate("command-failed");
    const result = await executeCheck({
      scope: "focused",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      commands: ["printf 'attempt\\n' >> attempts.txt", "exit 3"],
    });

    expect(result.outcome).toBe("failed");
    expect(result.classification).toBe("command-failed");
    expect(result.commands).toHaveLength(2);
    expect(result.commands?.[1]).toMatchObject({ index: 1, status: "failed", classification: "command-failed", exitCode: 3 });

    const attempts = await stat(join(candidate.path, "attempts.txt"));
    expect(attempts.isFile()).toBe(true);
    // Exactly one line: the failing command was executed once and never retried.
    expect((await readFile(join(candidate.path, "attempts.txt"), "utf8")).trim().split("\n")).toHaveLength(1);
  }, 60_000);

  itManagedExecution("classifies a settled process timeout with bounded evidence and reaps the process tree", async () => {
    const candidate = await ownedCandidate("timeout");
    const startedAt = Date.now();
    const result = await executeCheck({
      scope: "focused",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      commands: ["sleep 30"],
      timeoutMs: 400,
      samplePressure: () => CALM,
    });

    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(result.outcome).toBe("failed");
    expect(result.classification).toBe("timeout");
    expect(result.commands?.[0]).toMatchObject({
      status: "failed",
      classification: "timeout",
      timeoutState: "timed-out",
      timeoutMs: 400,
    });
    expect(result.commands?.[0]?.durationMs).toBeGreaterThanOrEqual(400);
  }, 60_000);

  itManagedExecution("classifies a timeout under sampled resource pressure as likely load-induced and still failed", async () => {
    const candidate = await ownedCandidate("load-induced");
    const result = await executeCheck({
      scope: "focused",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      commands: ["sleep 30"],
      timeoutMs: 400,
      samplePressure: () => SATURATED,
    });

    expect(result.outcome).toBe("failed");
    expect(result.classification).toBe("likely-load-induced-timeout");
    expect(result.commands?.[0]?.pressure).toMatchObject({ samples: 2, pressured: true, peakLoadPerCpu: 5 });
  }, 60_000);

  it("classifies a cancelled command as an infrastructure failure", async () => {
    const candidate = await ownedCandidate("cancelled");
    const controller = new AbortController();
    controller.abort();

    const result = await executeCheck({
      scope: "focused",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      commands: ["printf never-run"],
      signal: controller.signal,
    });

    expect(result.outcome).toBe("failed");
    expect(result.classification).toBe("infrastructure");
    expect(result.commands?.[0]).toMatchObject({ classification: "infrastructure", timeoutState: "not-timed-out" });
  }, 60_000);

  itManagedExecution("returns a stable action fingerprint for unchanged state and a different one after a mutation", async () => {
    const candidate = await ownedCandidate("fingerprint");
    const first = await executeCheck({
      scope: "focused",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      commands: ["exit 4"],
    });
    const second = await executeCheck({
      scope: "focused",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      commands: ["exit 4"],
    });
    expect(first.actionFingerprint).toBe(second.actionFingerprint);
    expect(first.operationId).toBe(second.operationId);

    await writeFile(join(candidate.path, "README.md"), "mutation\n", "utf8");
    const third = await executeCheck({
      scope: "focused",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      commands: ["exit 4"],
    });
    expect(third.actionFingerprint).not.toBe(first.actionFingerprint);
  }, 60_000);

  itManagedExecution("changes the action fingerprint when an already-dirty path's CONTENTS change", async () => {
    // Same HEAD, same tree, same dirty flag, same changed-path set — only the
    // bytes of an already-dirty file differ. Reporting that as an unchanged
    // action is exactly the blind-rerun loop this fingerprint exists to end.
    const candidate = await ownedCandidate("content-fingerprint");
    await writeFile(join(candidate.path, "README.md"), "first revision\n", "utf8");
    const run = () =>
      executeCheck({
        scope: "focused",
        cwd: candidate.path,
        ownershipId: candidate.ownershipId,
        commands: ["exit 4"],
      });

    const first = await run();
    const second = await run();
    expect(second.state.head).toBe(first.state.head);
    expect(second.state.tree).toBe(first.state.tree);
    expect(second.state.dirty).toBe(true);
    expect(second.state.changedFiles).toEqual(first.state.changedFiles);
    // Unchanged state is stable, byte for byte.
    expect(second.actionFingerprint).toBe(first.actionFingerprint);

    await writeFile(join(candidate.path, "README.md"), "second revision, different bytes entirely\n", "utf8");
    const third = await run();
    expect(third.state.head).toBe(first.state.head);
    expect(third.state.tree).toBe(first.state.tree);
    expect(third.state.changedFiles).toEqual(first.state.changedFiles);
    expect(third.state.pathDigests).not.toEqual(first.state.pathDigests);
    // ...and the fingerprint notices.
    expect(third.actionFingerprint).not.toBe(first.actionFingerprint);

    // Reverting the exact bytes returns to the exact original fingerprint.
    await writeFile(join(candidate.path, "README.md"), "first revision\n", "utf8");
    expect((await run()).actionFingerprint).toBe(first.actionFingerprint);
  }, 60_000);

  itManagedExecution("records bounded Git content digests for dirty paths and never their contents", async () => {
    const candidate = await ownedCandidate("digests");
    const secret = "top-secret-value-4b7c";
    await writeFile(join(candidate.path, "notes.txt"), `contains ${secret}\n`, "utf8");
    await writeFile(join(candidate.path, "README.md"), "still tracked and modified\n", "utf8");

    const result = await executeCheck({
      scope: "focused",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      commands: ["true"],
    });

    expect(result.state.dirty).toBe(true);
    expect(result.state.pathDigests.map((digest) => digest.path)).toEqual(["README.md", "notes.txt"]);
    // Git's own object id: a content digest, not the content.
    for (const digest of result.state.pathDigests) {
      expect(digest.blob).toMatch(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
    }
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("still tracked and modified");
  }, 60_000);

  itManagedExecution("marks a deleted changed path as absent rather than colliding with other states", async () => {
    const candidate = await ownedCandidate("digest-deleted");
    await rm(join(candidate.path, "README.md"));
    const deleted = await executeCheck({
      scope: "focused",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      commands: ["true"],
    });
    expect(deleted.state.pathDigests).toEqual([{ path: "README.md", blob: "absent" }]);

    // A file with identical contents but a different name must not collide
    // with the deleted path's sentinel.
    await writeFile(join(candidate.path, "notes.txt"), "content\n", "utf8");
    const renamed = await executeCheck({
      scope: "focused",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      commands: ["true"],
    });
    expect(renamed.state.pathDigests).toEqual([{ path: "README.md", blob: "absent" }, { path: "notes.txt", blob: renamed.state.pathDigests.find((d) => d.path === "notes.txt")!.blob }]);
    expect(renamed.actionFingerprint).not.toBe(deleted.actionFingerprint);
  }, 60_000);

  itManagedExecution("emits bounded progress events that carry no command text, output, or environment values", async () => {
    const candidate = await ownedCandidate("progress");
    const secret = "sekret-value-9f3a";
    const events: CheckProgressEvent[] = [];
    const result = await executeCheck({
      scope: "focused",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      commands: [`printf '%s from output' ${secret}`],
      env: { POIESIS_FOCUSED_SECRET: secret },
      progress: { emit: (event) => events.push(event) },
      retryReason: "mutation-since-last-attempt",
    });

    expect(events.map((event) => [event.phase, event.action, event.index])).toEqual([
      ["resolve-authority", "check-started", null],
      ["execute", "command-started", 0],
      ["execute", "command-settled", 0],
      ["settle", "check-settled", null],
    ]);
    expect(events.every((event) => event.operationId === result.operationId)).toBe(true);
    expect(events.map((event) => event.elapsedMs)).toEqual([...events.map((event) => event.elapsedMs)].sort((a, b) => a - b));
    expect(events[2]?.classification).toBe("passed");
    expect(events[3]).toMatchObject({ classification: null, retryReason: "mutation-since-last-attempt" });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("printf");
    expect(serialized).not.toContain(candidate.path);
    expect(serialized).not.toContain("POIESIS_FOCUSED_SECRET");
  }, 60_000);
});

describeManagedExecution("proof scope through the same executor (Spec #168 / ticket #172)", () => {
  it("issues the exact-candidate verification receipt and stays authoritative", async () => {
    const candidate = await ownedCandidate("proof");
    const result = await executeCheck({
      scope: "proof",
      cwd: candidate.path,
      ownershipId: candidate.ownershipId,
      candidateSha: candidate.headSha,
      commands: ["printf proof-ok"],
    });

    expect(result.scope).toBe("proof");
    expect(result.authoritative).toBe(true);
    expect(result.outcome).toBe("passed");
    expect(result.verification).toMatchObject({
      candidateSha: candidate.headSha,
      runtime: expect.any(String),
      receiptId: expect.any(String),
      receiptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const proof = result as ProofCheckResult;
    const noCommands: null = proof.commands;
    void noCommands;
    expect(proof.proof).toMatchObject({ candidateSha: candidate.headSha, cleanBefore: true, cleanAfter: true });
    expect(await receiptsExist()).toBe(true);
    const receipts = await readdir(join(commonDir, VERIFICATION_RECEIPT_DIRECTORY));
    expect(receipts).toHaveLength(1);
  }, 60_000);

  it("preserves verify's non-project-bound compatibility surface in proof scope", async () => {
    // A repository that never installed Poiesis is still a valid read-only
    // Verify surface: there is no runtime / installation identity to bind a
    // receipt to, and no Publish can follow. Reaching proof scope through the
    // executor must not narrow that.
    const bareRepository = await createTestRepository();
    bare.push(bareRepository.parent);

    const result = await executeCheck({
      scope: "proof",
      cwd: bareRepository.root,
      candidateSha: bareRepository.baseSha,
      commands: ["printf compatibility-surface"],
    });

    expect(result).toMatchObject({ scope: "proof", authoritative: true, outcome: "passed" });
    expect(result.verification).toBeNull();
    expect(result.proof).toMatchObject({ candidateSha: bareRepository.baseSha });
  }, 60_000);

  it("classifies a dirty exact candidate as dirty-candidate while preserving the fail-closed code", async () => {
    const candidate = await ownedCandidate("proof-dirty");
    await expect(
      executeCheck({
        scope: "proof",
        cwd: candidate.path,
        ownershipId: candidate.ownershipId,
        candidateSha: candidate.headSha,
        commands: ["printf dirtied > README.md"],
      }),
    ).rejects.toMatchObject({
      code: "DIRTY_CANDIDATE",
      details: { check: { classification: "dirty-candidate" } },
    });
  }, 60_000);

  it("classifies a proof-scope command failure without weakening the existing error code", async () => {
    const candidate = await ownedCandidate("proof-failed");
    await expect(
      executeCheck({
        scope: "proof",
        cwd: candidate.path,
        ownershipId: candidate.ownershipId,
        candidateSha: candidate.headSha,
        commands: ["exit 5"],
      }),
    ).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
      details: { check: { classification: "command-failed" } },
    });
  }, 60_000);

  it("classifies a later non-zero exit from the failing command's own evidence when the whole run outlasts the per-command bound", async () => {
    // `timeoutMs` is a PER-COMMAND bound, so a five-command plan legitimately
    // takes longer than that bound while every individual command settles well
    // inside it. Cumulative operation duration is therefore not evidence about
    // the command that failed: it must not turn a real non-zero exit into
    // `timeout-unknown`. The classification comes from the failing command's
    // own settled exit code, and the original typed error is preserved.
    const candidate = await ownedCandidate("proof-cumulative");
    await expect(
      executeCheck({
        scope: "proof",
        cwd: candidate.path,
        ownershipId: candidate.ownershipId,
        candidateSha: candidate.headSha,
        commands: ["sleep 1", "sleep 1", "sleep 1", "sleep 1", "exit 7"],
        timeoutMs: 3_000,
      }),
    ).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
      details: { failed: { exitCode: 7 }, check: { classification: "command-failed" } },
    });
  }, 60_000);

  it("still classifies a per-command proof timeout from the command that timed out", async () => {
    // The other half of the same contract: a genuine `COMMAND_TIMEOUT` is the
    // managed runner's own settled word and must remain a `timeout` however
    // long the run as a whole took.
    const candidate = await ownedCandidate("proof-timeout");
    await expect(
      executeCheck({
        scope: "proof",
        cwd: candidate.path,
        ownershipId: candidate.ownershipId,
        candidateSha: candidate.headSha,
        commands: ["sleep 30"],
        timeoutMs: 400,
        samplePressure: () => CALM,
      }),
    ).rejects.toMatchObject({
      code: "COMMAND_TIMEOUT",
      details: { check: { classification: "timeout" } },
    });
  }, 60_000);
});

/**
 * Spec #168 / ticket #172 — the agent-facing seam.
 *
 * `poiesis check` is the deterministic way an orchestrator reaches the
 * executor and gets classification + bounded evidence instead of raw shell
 * output. Its lifecycle authority stays explicit: the command resolves the
 * shared authority and refuses any workspace Poiesis does not own, and it
 * can only ever produce the non-authoritative focused scope. Proof remains
 * `poiesis verify` alone.
 */
describe("poiesis check CLI seam (Spec #168 / ticket #172)", () => {
  /**
   * Capture one output stream's writes. The CLI contract is "structured JSON
   * on stdout, progress lines on stderr", so the two are captured separately
   * and asserted separately.
   */
  function capture(target: { write: NodeJS.WriteStream["write"] }): { chunks: string[]; restore: () => void } {
    const chunks: string[] = [];
    const original = target.write.bind(target);
    target.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof target.write;
    return { chunks, restore: () => { target.write = original; } };
  }

  itManagedExecution("runs explicit commands and returns a non-authoritative focused result", async () => {
    const candidate = await ownedCandidate("cli-ok");
    await writeFile(join(candidate.path, "README.md"), "in-progress\n", "utf8");
    const { commandCheck } = await import("../src/cli.js");

    const out = capture(process.stdout);
    try {
      await commandCheck([
        "--command",
        "test -f README.md",
        "--command",
        "printf focused-cli",
        "--ownership-id",
        candidate.ownershipId,
        "--cwd",
        candidate.path,
      ]);
    } finally {
      out.restore();
    }
    const payload = JSON.parse(out.chunks.join("")) as {
      ok: boolean;
      operation: string;
      result: { scope: string; authoritative: boolean; outcome: string; commands: Array<{ stdout: string }> };
    };
    expect(payload).toMatchObject({ ok: true, operation: "check" });
    expect(payload.result).toMatchObject({ scope: "focused", authoritative: false, outcome: "passed" });
    expect(payload.result.commands[1]?.stdout).toBe("focused-cli");
  }, 60_000);

  itManagedExecution("fails closed with the classification and the complete bounded evidence", async () => {
    const candidate = await ownedCandidate("cli-failed");
    const { commandCheck } = await import("../src/cli.js");

    await expect(
      commandCheck([
        "--command",
        "printf boom 1>&2; exit 6",
        "--ownership-id",
        candidate.ownershipId,
        "--cwd",
        candidate.path,
      ]),
    ).rejects.toMatchObject({
      code: "FOCUSED_CHECK_FAILED",
      details: {
        check: {
          scope: "focused",
          outcome: "failed",
          authoritative: false,
          classification: "command-failed",
          verification: null,
          proof: null,
          commands: [{ index: 0, status: "failed", exitCode: 6, stderr: "boom" }],
        },
      },
    });
  }, 60_000);

  itManagedExecution("emits bounded progress lines on stderr only when asked", async () => {
    const candidate = await ownedCandidate("cli-progress");
    const { commandCheck } = await import("../src/cli.js");

    const quietErr = capture(process.stderr);
    const quietOut = capture(process.stdout);
    try {
      await commandCheck(["--command", "true", "--cwd", candidate.path, "--ownership-id", candidate.ownershipId]);
    } finally {
      quietErr.restore();
      quietOut.restore();
    }
    expect(quietErr.chunks.join("")).toBe("");

    const loudErr = capture(process.stderr);
    const loudOut = capture(process.stdout);
    try {
      await commandCheck([
        "--command",
        "true",
        "--progress",
        "--retry-reason",
        "new-hypothesis",
        "--cwd",
        candidate.path,
        "--ownership-id",
        candidate.ownershipId,
      ]);
    } finally {
      loudErr.restore();
      loudOut.restore();
    }
    const lines = loudErr.chunks.join("").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => line.action)).toEqual([
      "check-started",
      "command-started",
      "command-settled",
      "check-settled",
    ]);
    // End-to-end: a genuinely passing command must render its real
    // classification, not the redacted `unknown` placeholder.
    expect(lines[2]).toMatchObject({ phase: "execute", action: "command-settled", index: 0, classification: "passed" });
    expect(lines[1]?.classification).toBeNull();
    expect(lines[3]?.retryReason).toBe("new-hypothesis");
    expect(lines.join("\n")).not.toContain("unknown");
  }, 60_000);

  it("requires at least one explicit --command", async () => {
    const { commandCheck } = await import("../src/cli.js");
    await expect(commandCheck(["--cwd", repository.root])).rejects.toMatchObject({
      code: "MISSING_ARGUMENT",
    });
  }, 60_000);

  it("refuses a workspace Poiesis does not own", async () => {
    const foreign = join(repository.parent, `foreign-cli-check-${Date.now()}`);
    await run("git", ["worktree", "add", "--detach", "--quiet", foreign, repository.baseSha], {
      cwd: repository.root,
    });
    const { commandCheck } = await import("../src/cli.js");

    await expect(commandCheck(["--command", "true", "--cwd", foreign])).rejects.toMatchObject({
      code: "WORKSPACE_OWNERSHIP_UNKNOWN",
    });
  }, 60_000);
});

/**
 * Spec #168 / ticket #177 — a containment refusal is not a failed check.
 *
 * `poiesis check` executes caller-supplied command TEXT, which is the surface
 * that requires strong process containment, and it refuses on a host that
 * cannot provide it: before any process exists for the unavailable case, and
 * without ever running the caller's command for the refused case.
 *
 * Neither refusal is "your code failed". Collapsing either into
 * `FOCUSED_CHECK_FAILED` would tell the operator to edit their code for a host
 * limitation, and the `migration` line that failure carries points at
 * `poiesis verify` — which executes managed command text through the SAME
 * boundary and refuses identically. So this surface rethrows each refusal with
 * its own code and its own `reason`/`platform`/`detail`/`remediation`, with the
 * bounded check evidence attached.
 *
 * Both assertions are pure control flow over the public `commandCheck` seam and
 * mock the kernel boundary rather than requiring one, so they run on every host
 * — including the hosts whose real answer is "no".
 */
describe("an actionable containment refusal survives the focused surface (Spec #168 / ticket #177)", () => {
  /** One flattened argv per spawn attempt, so "no command ran" is observable. */
  let spawns: string[] = [];

  async function dispatchWithMockedKernel(
    prepare: () => void,
    argv: string[],
  ): Promise<{ error: unknown; spawns: string[] }> {
    vi.resetModules();
    spawns = [];
    prepare();
    try {
      const { commandCheck } = await import("../src/cli.js");
      let error: unknown = null;
      try {
        await commandCheck(argv);
      } catch (thrown) {
        error = thrown;
      }
      return { error, spawns };
    } finally {
      vi.doUnmock("node:fs");
      vi.doUnmock("node:child_process");
      vi.doUnmock("../src/containment.js");
      vi.resetModules();
    }
  }

  /** Record every spawn the surface attempts, so "no command ran" is observable. */
  function recordSpawns(): void {
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawn: ((...args: unknown[]) => {
          spawns.push([String(args[0]), ...(args[1] as string[]).map((arg) => String(arg))].join(" "));
          return Reflect.apply(actual.spawn, undefined, args) as never;
        }) as typeof actual.spawn,
      };
    });
  }

  it("rethrows a pre-spawn PROCESS_CONTAINMENT_UNAVAILABLE with its own reason and remediation", { timeout: 60_000 }, async () => {
    const candidate = await ownedCandidate("cli-unavailable");
    const marker = "poiesis-must-not-run-marker";
    const observed = await dispatchWithMockedKernel(
      () => {
        recordSpawns();
        vi.doMock("node:fs", async () => {
          const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
          return {
            ...actual,
            readFileSync: ((path: string, ...rest: unknown[]) => {
              if (path === "/proc/self/cgroup") {
                throw Object.assign(new Error("no delegated cgroup v2 subtree on this host"), { code: "EACCES" });
              }
              return Reflect.apply(actual.readFileSync, undefined, [path, ...rest]) as string;
            }) as typeof actual.readFileSync,
          };
        });
      },
      ["--command", `printf %s ${marker}`, "--ownership-id", candidate.ownershipId, "--cwd", candidate.path],
    );

    expect(observed.error).toMatchObject({
      code: "PROCESS_CONTAINMENT_UNAVAILABLE",
      details: {
        containment: "cgroup-v2",
        reason: "NO_CGROUP_V2",
        platform: expect.any(String),
        remediation: expect.stringContaining("strong containment"),
        command: `printf %s ${marker}`,
        commandIndex: 0,
        // The bounded evidence is still attached: this is not a failure with no
        // record of what was attempted, against which state.
        check: {
          scope: "focused",
          authoritative: false,
          outcome: "failed",
          verification: null,
          proof: null,
          commands: [{ index: 0, status: "failed", failureCode: "PROCESS_CONTAINMENT_UNAVAILABLE" }],
        },
      },
    });
    // Not the generic failed check, and not advice to escalate to a surface
    // that requires the very capability this host is missing.
    const error = observed.error as { details: Record<string, unknown>; message: string };
    expect(error.details.migration).toBeUndefined();
    expect(error.message).not.toContain("poiesis verify");
    // Pre-spawn: the refusal precedes the process, so the command never ran.
    expect(observed.spawns.filter((argv) => argv.includes(marker))).toEqual([]);
  });

  it("rethrows a PROCESS_CONTAINMENT_REFUSED with the admission reason, without running the command", { timeout: 60_000 }, async () => {
    const candidate = await ownedCandidate("cli-refused");
    const marker = "poiesis-must-not-run-marker";
    const leaf = "/poiesis-executor-fake-cgroup-leaf";
    const observed = await dispatchWithMockedKernel(
      () => {
        // The kernel boundary is scripted; the admission report format, the
        // confirmation predicate, and the refusal itself stay real.
        vi.doMock("../src/containment.js", async () => {
          const actual = await vi.importActual<typeof import("../src/containment.js")>("../src/containment.js");
          return {
            ...actual,
            provisionContainment: (input: { model: string; operationId: string }) => ({
              model: input.model,
              operationId: input.operationId,
              leaf,
            }),
            settleContainment: async (leased: { model: string; leaf: string | null }) => ({
              model: leased.model,
              leaf: leased.leaf,
              survived: [],
              confirmed: true,
            }),
            releaseContainment: () => undefined,
          };
        });
        // A prologue that never reports and never exits: the exact shape of a
        // child Poiesis cannot place inside the boundary it provisioned.
        vi.doMock("node:child_process", async () => {
          const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
          return {
            ...actual,
            spawn: ((command: string, ...rest: unknown[]) => {
              const argv = (rest[0] as string[]) ?? [];
              spawns.push([command, ...argv].join(" "));
              if (command !== "/bin/sh" || !argv.includes("poiesis-admission")) {
                return Reflect.apply(actual.spawn, undefined, [command, ...rest]) as never;
              }
              const fake = new EventEmitter() as ChildProcess;
              const report = new PassThrough();
              Object.assign(fake, {
                pid: undefined,
                stdin: null,
                stdout: null,
                stderr: null,
                stdio: [null, null, null, report],
                kill: () => true,
                unref: () => fake,
              });
              setTimeout(() => report.end(), 20);
              return fake;
            }) as typeof actual.spawn,
          };
        });
      },
      ["--command", `printf %s ${marker}`, "--ownership-id", candidate.ownershipId, "--cwd", candidate.path],
    );

    expect(observed.error).toMatchObject({
      code: "PROCESS_CONTAINMENT_REFUSED",
      details: {
        containment: "cgroup-v2",
        reason: "ADMISSION_UNCONFIRMED",
        detail: expect.stringContaining("without reporting"),
        check: {
          scope: "focused",
          outcome: "failed",
          commands: [{ index: 0, status: "failed", failureCode: "PROCESS_CONTAINMENT_REFUSED" }],
        },
      },
    });
    // Exactly one managed spawn: the Poiesis-owned prologue. The caller's
    // command was never `exec`'d, because nothing may run before admission is
    // confirmed.
    expect(observed.spawns.filter((argv) => argv.includes("poiesis-admission"))).toHaveLength(1);
    const details = (observed.error as { details: Record<string, unknown> }).details;
    expect(details.migration).toBeUndefined();
    expect(details.remediation).toBeUndefined();
  });
});
/**
 * Ticket #45 — Init receipt rollback identity guard.
 *
 * Acceptance criteria:
 *   1. Init records whether this invocation successfully created the receipt
 *      and its exact written identity. (Tickets #43/#44 introduced this
 *      pattern for ordinary update and bootstrap; init must extend it for
 *      the receipt it writes on a fresh install.)
 *   2. Catch/rollback removes the receipt only when creation succeeded AND
 *      current bytes still equal that authored identity. The existing
 *      unconditional `removeOwnershipReceipt(root)` call in the init catch
 *      block is replaced with a small helper that gates on the exact
 *      authored bytes captured by the same invocation.
 *   3. Pre-existing AND concurrently created/replaced receipts survive
 *      byte-for-byte. Any receipt that init did not author is left
 *      untouched by rollback.
 *   4. Failed init still restores all other transaction-authored state
 *      without weakening receipt authority. The catch block keeps its
 *      existing rollback order (ownership receipt, manifest, OpenCode
 *      config, skills, materialized files, gitignore, created directories);
 *      only the receipt step becomes identity-gated.
 *
 * The tests below cover the three required scenarios:
 *   - pre-existing foreign receipt before init starts;
 *   - foreign writer replacing the receipt between init's
 *     `createOwnershipReceipt` and the catch block (concurrent replacement);
 *   - normal init failure where THIS invocation's authored receipt is the
 *     only one removed by rollback.
 */
import { exists } from "../src/fs.js";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { init } from "../src/maintenance.js";
import { ownershipReceiptLocation } from "../src/receipt.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

const FOREIGN_RECEIPT_BYTES = `{"schema":1,"commonDir":"/dev/null","workspace":"/dev/null","installationId":"foreign-receipt","manifestDigest":"deadbeef","generation":7}\n`;

async function installCustomFakeOpencode(options: {
  failOnDebug?: boolean;
  foreignReceiptPath?: string;
  stateful?: { counterFile: string; threshold: number };
}): Promise<{ bin: string; restore: () => void }> {
  const bin = await mkdtemp(join(tmpdir(), "poiesis-init-receipt-bin-"));
  const script = join(bin, "opencode");
  const thresholdSource = options.stateful === undefined ? "" : options.stateful.threshold.toString();
  const counterFile = options.stateful?.counterFile ?? "";
  const foreignReceiptPath = options.foreignReceiptPath ?? "";
  const body = `#!/bin/sh
case "$1" in
  --version) printf "1.18.29\\n"; exit 0 ;;
  models) printf "openai/gpt-5.6-sol\\nminimax/MiniMax-M3\\n"; exit 0 ;;
  debug)
    if [ -n "${counterFile}" ]; then
      count=\$(cat "${counterFile}" 2>/dev/null || echo "0")
      count=\$(expr "\${count}" + 1)
      mkdir -p "\$(dirname "${counterFile}")"
      printf '%s' "\${count}" > "${counterFile}"
      if [ "\${count}" -gt "${thresholdSource}" ]; then
        if [ -n "${foreignReceiptPath}" ]; then
          mkdir -p "\$(dirname "${foreignReceiptPath}")"
          printf '%s' '${FOREIGN_RECEIPT_BYTES}' > "${foreignReceiptPath}"
        fi
        printf 'stateful fake: debug call #\${count} exceeds threshold ${thresholdSource}\\n' >&2
        exit 1
      fi
    elif [ -n "${foreignReceiptPath}" ]; then
      mkdir -p "\$(dirname "${foreignReceiptPath}")"
      printf '%s' '${FOREIGN_RECEIPT_BYTES}' > "${foreignReceiptPath}"
    fi
    if [ "$POIESIS_TEST_OPENCODE_FAIL" = "1" ]; then
      printf 'forced doctor failure\\n' >&2
      exit 1
    fi
    exit 0
    ;;
esac
exit 0
`;
  await writeFile(script, body);
  await chmod(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = previousPath === undefined || previousPath === "" ? bin : `${bin}:${previousPath}`;
  return {
    bin,
    restore: () => {
      process.env.PATH = previousPath;
    },
  };
}

describe("ticket #45 — init receipt rollback identity guard", () => {
  const repositories: TestRepository[] = [];
  const bins: string[] = [];

  afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repo) => rm(repo.parent, { recursive: true, force: true })));
    for (const bin of bins.splice(0)) {
      await rm(bin, { recursive: true, force: true });
    }
    delete process.env.POIESIS_TEST_OPENCODE_FAIL;
    delete process.env.POIESIS_TEST_FOREIGN_RECEIPT_PATH;
  });

  // Acceptance criteria #1 + #2 + #3 (pre-existing collision).
  // A foreign receipt pre-populating the canonical workspace receipt
  // path must survive an init that collides on `createOwnershipReceipt`.
  it("preserves a pre-existing foreign receipt when init collides on createOwnershipReceipt", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);

    const receiptPath = await ownershipReceiptLocation(repository.root);
    const foreignBytes = Buffer.from(FOREIGN_RECEIPT_BYTES);
    await mkdir(join(receiptPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(receiptPath, foreignBytes);

    await expect(
      init(repository.root, testConfig(repository), {
        skipSkills: true,
        allowFixtureAdapters: true,
      }),
    ).rejects.toMatchObject({ code: "OWNERSHIP_RECEIPT_CONFLICT" });

    // Pre-existing foreign receipt survives byte-for-byte; helper did not delete it.
    expect(Buffer.compare(await readFile(receiptPath), foreignBytes)).toBe(0);
    // No Poiesis install state was left behind; the catch block restored every other init byte.
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
  }, 60_000);

  // Acceptance criteria #1 + #2 + #3 (concurrent replacement).
  // A foreign writer landing between init's `createOwnershipReceipt` and
  // the catch block must not be overwritten/deleted by rollback. The test
  // uses a stateful fake `opencode` whose second `debug config` call
  // writes a foreign receipt at the canonical receipt path BEFORE
  // failing, so the catch block observes foreign bytes on disk while
  // `authoredReceiptBytes` is set to the bytes `createOwnershipReceipt`
  // authored.
  it("preserves a concurrently replaced receipt when init fails after createOwnershipReceipt", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);

    const receiptPath = await ownershipReceiptLocation(repository.root);
    const counterDir = await mkdtemp(join(tmpdir(), "poiesis-init-receipt-counter-"));
    const counterFile = join(counterDir, "count");
    bins.push(counterDir);
    // Stateful: threshold=1 → first call succeeds, second call writes
    // foreign receipt then exits 1. Init's first `debug config` call is
    // `validateOpenCodeConfigPayload` (succeeds); the second is inside
    // `doctor → validateOpenCodeConfig` (fails AFTER writing foreign
    // bytes). Init's catch block fires with `authoredReceiptBytes`
    // captured from `createOwnershipReceipt`.
    const env = await installCustomFakeOpencode({
      stateful: { counterFile, threshold: 1 },
      foreignReceiptPath: receiptPath,
    });
    bins.push(env.bin);

    await expect(
      init(repository.root, testConfig(repository), {
        skipSkills: false,
        allowFixtureAdapters: true,
      }),
    ).rejects.toMatchObject({ code: "INIT_DOCTOR_FAILED" });

    env.restore();

    // The foreign bytes that landed during the failed debug call survive byte-for-byte.
    const afterBytes = await readFile(receiptPath, "utf8");
    expect(afterBytes === FOREIGN_RECEIPT_BYTES).toBe(true);
    // No install state was left behind; all init-authored bytes were rolled back.
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
  }, 60_000);

  // Acceptance criteria #1 + #2 + #4 (normal init rollback).
  // Init succeeds in creating its own receipt, then a doctor failure
  // triggers rollback. The catch block MUST remove the receipt THIS
  // invocation authored and leave every other rollback step intact.
  it("removes only the receipt authored by this init on later doctor failure", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);

    // Stateful fake: first `debug config` call succeeds (init's preflight
    // schema probe); second `debug config` call fails (doctor's schema
    // probe) — so the catch block fires AFTER `createOwnershipReceipt`.
    const counterDir = await mkdtemp(join(tmpdir(), "poiesis-init-receipt-counter-"));
    const counterFile = join(counterDir, "count");
    bins.push(counterDir);
    const env = await installCustomFakeOpencode({
      stateful: { counterFile, threshold: 1 },
    });
    bins.push(env.bin);

    await expect(
      init(repository.root, testConfig(repository), {
        skipSkills: false,
        allowFixtureAdapters: true,
      }),
    ).rejects.toMatchObject({ code: "INIT_DOCTOR_FAILED" });

    env.restore();

    // The receipt authored by THIS invocation was removed; no foreign receipt existed, so the path is absent.
    const receiptPath = await ownershipReceiptLocation(repository.root);
    expect(await exists(receiptPath)).toBe(false);
    // Every other init-authored byte also rolled back (catch block fires in reverse write order).
    expect(await exists(join(repository.root, ".poiesis"))).toBe(false);
  }, 60_000);
});

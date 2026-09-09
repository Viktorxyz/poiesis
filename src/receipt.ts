import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { PoiesisError } from "./errors.js";
import { atomicCreate, atomicWrite, exists } from "./fs.js";
import { hashContent } from "./hash.js";
import { serializeManifest, type Manifest } from "./manifest.js";
import { run } from "./process.js";

const RECEIPT_DIRECTORY = "poiesis-receipts-v1";

export interface OwnershipReceipt {
  schema: 1;
  commonDir: string;
  workspace: string;
  installationId: string;
  manifestDigest: string;
  generation: number;
}

async function repositoryCommonDir(root: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--git-common-dir"], { cwd: root });
  const commonDir = isAbsolute(result.stdout) ? result.stdout : resolve(root, result.stdout);
  return realpath(commonDir);
}

export async function ownershipReceiptLocation(root: string): Promise<string> {
  return (await receiptPath(root)).path;
}

async function receiptPath(root: string): Promise<{ commonDir: string; path: string }> {
  const commonDir = await repositoryCommonDir(root);
  const workspace = await realpath(root);
  return {
    commonDir,
    path: join(commonDir, RECEIPT_DIRECTORY, `${hashContent(workspace)}.json`),
  };
}

export function manifestDigest(manifest: Manifest): string {
  return hashContent(serializeManifest(manifest));
}

function parseReceipt(value: unknown, path: string): OwnershipReceipt {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema" in value) ||
    value.schema !== 1 ||
    !("commonDir" in value) ||
    typeof value.commonDir !== "string" ||
    !("workspace" in value) ||
    typeof value.workspace !== "string" ||
    !("installationId" in value) ||
    typeof value.installationId !== "string" ||
    value.installationId.length === 0 ||
    !("manifestDigest" in value) ||
    typeof value.manifestDigest !== "string" ||
    !("generation" in value) ||
    typeof value.generation !== "number" ||
    !Number.isInteger(value.generation) ||
    value.generation < 1
  ) {
    throw new PoiesisError("OWNERSHIP_RECEIPT_INVALID", "Ownership receipt is invalid", { path });
  }
  return value as OwnershipReceipt;
}

export async function ownershipReceiptExists(root: string): Promise<boolean> {
  const { path } = await receiptPath(root);
  return exists(path);
}

export async function readOwnershipReceipt(root: string): Promise<OwnershipReceipt> {
  const { path } = await receiptPath(root);
  if (!(await exists(path))) {
    throw new PoiesisError("OWNERSHIP_RECEIPT_MISSING", "Ownership receipt is missing", { path });
  }
  return parseReceipt(JSON.parse(await readFile(path, "utf8")), path);
}

export async function assertOwnershipReceipt(root: string, manifest: Manifest): Promise<OwnershipReceipt> {
  const workspace = await realpath(root);
  const { commonDir, path } = await receiptPath(root);
  const receipt = await readOwnershipReceipt(root);
  if (receipt.commonDir !== commonDir) {
    throw new PoiesisError("OWNERSHIP_RECEIPT_MISMATCH", "Ownership receipt does not belong to this repository", {
      path,
      expected: commonDir,
      actual: receipt.commonDir,
    });
  }
  if (receipt.workspace !== workspace) {
    throw new PoiesisError("OWNERSHIP_RECEIPT_MISMATCH", "Ownership receipt does not belong to this workspace", {
      path,
      expected: workspace,
      actual: receipt.workspace,
    });
  }
  const digest = manifestDigest(manifest);
  if (receipt.manifestDigest !== digest) {
    throw new PoiesisError("OWNERSHIP_RECEIPT_MISMATCH", "Ownership receipt does not match the current manifest", {
      path,
      expected: digest,
      actual: receipt.manifestDigest,
    });
  }
  return receipt;
}

async function writeReceipt(path: string, receipt: OwnershipReceipt, create: boolean): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  if (create) await atomicCreate(path, content);
  else await atomicWrite(path, content);
}

export async function createOwnershipReceipt(root: string, manifest: Manifest): Promise<OwnershipReceipt> {
  const workspace = await realpath(root);
  const { commonDir, path } = await receiptPath(root);
  if (await exists(path)) {
    throw new PoiesisError("OWNERSHIP_RECEIPT_CONFLICT", "An ownership receipt already exists", { path });
  }
  const receipt: OwnershipReceipt = {
    schema: 1,
    commonDir,
    workspace,
    installationId: randomUUID(),
    manifestDigest: manifestDigest(manifest),
    generation: 1,
  };
  await writeReceipt(path, receipt, true);
  return receipt;
}

export async function replaceOwnershipReceipt(
  root: string,
  manifest: Manifest,
  previous: OwnershipReceipt,
): Promise<OwnershipReceipt> {
  const { path } = await receiptPath(root);
  const next: OwnershipReceipt = {
    ...previous,
    manifestDigest: manifestDigest(manifest),
    generation: previous.generation + 1,
  };
  await writeReceipt(path, next, false);
  return next;
}

export async function restoreOwnershipReceipt(root: string, receipt: OwnershipReceipt | undefined): Promise<void> {
  if (receipt === undefined) return;
  const { path } = await receiptPath(root);
  await writeReceipt(path, receipt, false);
}

export async function removeOwnershipReceipt(root: string): Promise<void> {
  const { path } = await receiptPath(root);
  await rm(path, { force: true });
}

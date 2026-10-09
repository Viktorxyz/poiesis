/**
 * Spec #203 / ticket #204 — the read-only `poiesis latest` surface.
 *
 * The contract this file pins:
 *
 *   - the report envelope is exactly `{ installed, latest, newerAvailable,
 *     lookup }` plus `updateCommand` ONLY when a newer published version
 *     exists;
 *   - `updateCommand` is the one copy-paste form
 *     `pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@<latest> update`,
 *     pinned to the exact published version and never to `@latest`;
 *   - the compare is NUMERIC X.Y.Z, so `1.10.0` is newer than `1.9.0`, and a
 *     version that is not a plain numeric `X.Y.Z` on EITHER side is not a
 *     version this report can act on at all;
 *   - the network path FAILS OPEN: a failed, rejected, or empty lookup — and
 *     equally a non-`X.Y.Z` version on either side — still reports the
 *     installed version with `latest: null`, `lookup: "unavailable"`, no
 *     `newerAvailable`, and no `updateCommand`, under `ok: true`;
 *   - the ONE fail-closed case is a project that is not installed, and it is
 *     decided BEFORE any lookup is attempted;
 *   - nothing is mutated — the operation is a pure read;
 *   - every test injects the version lookup, so no test reaches npm;
 *   - the operation is NOT cancellable, matching the read-only operations it
 *     sits beside;
 *   - the primary agent reaches it through the exact-version route already
 *     projected into `permission.bash`; no `@latest` route is widened and no
 *     Specialist gains any `latest` permission.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commandLatest, dispatchCli } from "../src/cli.js";
import { doctor, init } from "../src/maintenance.js";
import { inspectProject } from "../src/inspect.js";
import { desiredOpenCodePatches } from "../src/opencode.js";
import { run } from "../src/process.js";
import { latestReport, type LatestVersionLookup } from "../src/latest.js";
import { createTestRepository, testConfig, type TestRepository } from "./helpers.js";

const UPDATE_COMMAND = "pnpm --config.dlx-cache-max-age=0 dlx poiesis-cli@";

let repository: TestRepository;
let uninstalled: TestRepository;

beforeAll(async () => {
  repository = await createTestRepository();
  await init(repository.root, testConfig(repository), {
    skipSkills: true,
    allowFixtureAdapters: true,
  });
  uninstalled = await createTestRepository();
}, 120_000);

afterAll(async () => {
  for (const candidate of [repository, uninstalled]) {
    if (candidate !== undefined) await rm(candidate.parent, { recursive: true, force: true });
  }
});

/**
 * Re-stamp the durable installed version.
 *
 * `latest` reads `manifest.poiesisVersion` and nothing else about the
 * installation, so re-writing that one field is the honest fixture for a
 * given installed/published pair — a full re-install per case would prove
 * nothing extra and would cost an OpenCode transaction each time.
 */
async function installedVersion(version: string): Promise<void> {
  const path = join(repository.root, ".poiesis", "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  manifest.poiesisVersion = version;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** A lookup that records every call so "was the network touched?" is assertable. */
function countingLookup(result: string | null | Error): {
  lookup: LatestVersionLookup;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    lookup: async () => {
      calls += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

async function captureStdout<T>(operation: () => Promise<T>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await operation();
    return chunks.join("");
  } finally {
    process.stdout.write = original;
  }
}

describe("poiesis latest — the update-availability report (Spec #203 / ticket #204)", () => {
  it("reports a newer published version with the exact copy-paste update command", async () => {
    await installedVersion("1.5.0");
    const report = await latestReport(repository.root, { lookup: async () => "1.6.0" });
    expect(report).toEqual({
      installed: "1.5.0",
      latest: "1.6.0",
      newerAvailable: true,
      updateCommand: `${UPDATE_COMMAND}1.6.0 update`,
      lookup: "ok",
    });
  });

  it("omits updateCommand entirely when the installed version equals the published one", async () => {
    await installedVersion("1.5.0");
    const report = await latestReport(repository.root, { lookup: async () => "1.5.0" });
    expect(report).toEqual({
      installed: "1.5.0",
      latest: "1.5.0",
      newerAvailable: false,
      lookup: "ok",
    });
    expect("updateCommand" in report).toBe(false);
  });

  it("omits updateCommand when the installed version is already ahead of the published one", async () => {
    await installedVersion("1.7.0");
    const report = await latestReport(repository.root, { lookup: async () => "1.6.0" });
    expect(report).toEqual({
      installed: "1.7.0",
      latest: "1.6.0",
      newerAvailable: false,
      lookup: "ok",
    });
  });

  it("compares numerically: 1.10.0 is newer than 1.9.0", async () => {
    await installedVersion("1.9.0");
    const report = await latestReport(repository.root, { lookup: async () => "1.10.0" });
    expect(report.newerAvailable).toBe(true);
    expect(report.updateCommand).toBe(`${UPDATE_COMMAND}1.10.0 update`);
  });

  it("compares numerically per component: 1.5.10 is newer than 1.5.9", async () => {
    await installedVersion("1.5.9");
    const report = await latestReport(repository.root, { lookup: async () => "1.5.10" });
    expect(report.newerAvailable).toBe(true);
  });

  it("fails open on a non-numeric published version: no version reported, no notice", async () => {
    await installedVersion("1.5.0");
    const report = await latestReport(repository.root, { lookup: async () => "1.6.0-beta.1" });
    // A version the rule refuses to order is not a version this report can act
    // on, so the envelope is indistinguishable from an unreachable registry:
    // `latest: null`, `lookup: "unavailable"`, no notice. Echoing the raw
    // string under `lookup: "ok"` would claim a comparison that never ran.
    expect(report).toEqual({
      installed: "1.5.0",
      latest: null,
      newerAvailable: false,
      lookup: "unavailable",
    });
    expect("updateCommand" in report).toBe(false);
  });

  it("fails open on a non-numeric installed version, still reporting the raw installed string", async () => {
    await installedVersion("1.6.0-rc.1");
    const report = await latestReport(repository.root, { lookup: async () => "1.5.0" });
    // `installed` is the durable manifest value verbatim — it is a fact about
    // this project, not a comparison result — so the unorderable string is
    // reported; the published side is dropped because it could not be ordered
    // against anything.
    expect(report).toEqual({
      installed: "1.6.0-rc.1",
      latest: null,
      newerAvailable: false,
      lookup: "unavailable",
    });
    expect("updateCommand" in report).toBe(false);
  });

  it("fails open when the registry lookup rejects", async () => {
    await installedVersion("1.5.0");
    const report = await latestReport(repository.root, {
      lookup: async () => {
        throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
      },
    });
    expect(report).toEqual({
      installed: "1.5.0",
      latest: null,
      newerAvailable: false,
      lookup: "unavailable",
    });
  });

  it("fails open when the registry lookup resolves no version", async () => {
    await installedVersion("1.5.0");
    const report = await latestReport(repository.root, { lookup: async () => null });
    expect(report).toEqual({
      installed: "1.5.0",
      latest: null,
      newerAvailable: false,
      lookup: "unavailable",
    });
  });

  it("performs the lookup exactly once per invocation", async () => {
    await installedVersion("1.5.0");
    const injected = countingLookup("1.6.0");
    await latestReport(repository.root, { lookup: injected.lookup });
    expect(injected.calls()).toBe(1);
  });

  it("mutates nothing: the working tree is byte-identical before and after", async () => {
    await installedVersion("1.5.0");
    const before = await gitStatus(repository.root);
    await latestReport(repository.root, { lookup: async () => "1.6.0" });
    expect(await gitStatus(repository.root)).toBe(before);
  });

  it("leaves `doctor` and `inspect` reporting exactly what they reported before it ran", async () => {
    await installedVersion("1.5.0");
    const inspectBefore = await inspectProject(repository.root);
    const doctorBefore = await doctor(repository.root);
    await latestReport(repository.root, { lookup: async () => "1.6.0" });
    // The new operation is an ADDITIONAL read. It changes neither what the
    // existing diagnosis surfaces report nor whether they succeed, which is
    // the only way "doctor / inspect are unchanged" can be observed rather
    // than asserted.
    expect(await inspectProject(repository.root)).toEqual(inspectBefore);
    expect(await doctor(repository.root)).toEqual(doctorBefore);
  });
});

describe("poiesis latest — the one fail-closed case (Spec #203 / ticket #204)", () => {
  it("fails closed when the project is not installed", async () => {
    const injected = countingLookup("1.6.0");
    await expect(latestReport(uninstalled.root, { lookup: injected.lookup })).rejects.toMatchObject({
      code: "POIESIS_NOT_INSTALLED",
    });
  });

  it("decides the missing install before any registry lookup is attempted", async () => {
    const injected = countingLookup("1.6.0");
    await expect(latestReport(uninstalled.root, { lookup: injected.lookup })).rejects.toMatchObject({
      code: "POIESIS_NOT_INSTALLED",
    });
    expect(injected.calls()).toBe(0);
  });
});

describe("poiesis latest — CLI surface (Spec #203 / ticket #204)", () => {
  it("writes the structured success envelope under operation `latest`", async () => {
    await installedVersion("1.5.0");
    const stdout = await captureStdout(() =>
      commandLatest(["--cwd", repository.root], { lookup: async () => "1.6.0" }),
    );
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      operation: "latest",
      result: {
        installed: "1.5.0",
        latest: "1.6.0",
        newerAvailable: true,
        updateCommand: `${UPDATE_COMMAND}1.6.0 update`,
        lookup: "ok",
      },
    });
  });

  it("omits updateCommand from the envelope when no newer version is published", async () => {
    await installedVersion("1.5.0");
    const stdout = await captureStdout(() =>
      commandLatest(["--cwd", repository.root], { lookup: async () => "1.5.0" }),
    );
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      operation: "latest",
      result: { installed: "1.5.0", latest: "1.5.0", newerAvailable: false, lookup: "ok" },
    });
  });

  it("succeeds with the fail-open envelope when the published version is not comparable", async () => {
    await installedVersion("1.5.0");
    const stdout = await captureStdout(() =>
      commandLatest(["--cwd", repository.root], { lookup: async () => "1.6.0-beta.1" }),
    );
    // Fail-open means `ok: true`, never an error envelope: an uncomparable
    // version is a quiet report, not a broken one.
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      operation: "latest",
      result: { installed: "1.5.0", latest: null, newerAvailable: false, lookup: "unavailable" },
    });
  });

  it("dispatches `latest` from the public CLI and installs no signal handlers", async () => {
    const before = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    await expect(dispatchCli(["latest", "--cwd", uninstalled.root])).rejects.toMatchObject({
      code: "POIESIS_NOT_INSTALLED",
    });
    expect(process.listenerCount("SIGINT")).toBe(before.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
  });

  it("lists the command in the CLI help text", async () => {
    const stdout = await captureStdout(async () => {
      await dispatchCli(["help"]);
    });
    expect(stdout).toMatch(/poiesis latest/);
  });
});

describe("poiesis latest — the projected permission surface is unchanged (Spec #203 / ticket #204)", () => {
  it("reaches the primary agent through the exact-version route, with no @latest widening", () => {
    const patches = desiredOpenCodePatches(testConfig(repository), "1.5.0");
    const primary = patches.find((patch) => patch.path.join(".") === "agent.poiesis")?.value as {
      permission: { bash: Record<string, string> };
    };
    expect(primary.permission.bash["pnpm dlx poiesis-cli@*"]).toBe("deny");
    expect(primary.permission.bash["pnpm dlx poiesis-cli@1.5.0 *"]).toBe("allow");
    expect(Object.keys(primary.permission.bash).filter((key) => key.includes("@latest"))).toEqual([]);
  });

  it("grants no Specialist any `latest` route", () => {
    const patches = desiredOpenCodePatches(testConfig(repository), "1.5.0");
    for (const patch of patches) {
      const [scope, name] = patch.path;
      if (scope !== "agent" || name === "poiesis") continue;
      const value = patch.value as { permission?: { bash?: Record<string, string> } };
      const bash = value.permission?.bash ?? {};
      expect(
        Object.keys(bash).filter((key) => key.includes(" latest")),
        `${name} must not be granted a \`latest\` route`,
      ).toEqual([]);
      expect(
        Object.keys(bash).filter((key) => key.includes("@latest")),
        `${name} must not be granted an \`@latest\` route`,
      ).toEqual([]);
    }
  });
});

async function gitStatus(root: string): Promise<string> {
  return (await run("git", ["status", "--porcelain"], { cwd: root })).stdout;
}
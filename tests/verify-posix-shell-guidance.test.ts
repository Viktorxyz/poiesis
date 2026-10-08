/**
 * Spec #139 / ticket #164 — the documented POSIX-shell contract of Verify.
 *
 * `verify()` has always executed every configured command as
 * `/bin/sh -c <command>` (`src/git.ts`), and post-integration verification
 * reaches the same seam through `verifyIntegratedCommit`, inside a temporary
 * detached worktree. The runtime is therefore POSIX-shell dependent, and
 * nothing in the package said so: no `package.json` `os`, no preflight, no
 * interpreter probe, no fallback. An Author on a host with no `/bin/sh` learns
 * this only when the first verification command fails, and an integrator
 * reading the compatibility matrix has no sentence telling them what
 * interpreter their `verification.commands` strings are handed to, or from
 * which directory.
 *
 * This ticket states the requirement where an Author reads it before
 * installing (the README requirements list), states the exact execution route
 * an integrator relies on (COMPATIBILITY), and states the authoring rule for
 * both the configured and the `init`-discovered command strings (the canonical
 * config template). It changes NO runtime: the interpreter, the working
 * directory, the recorded evidence, the per-command timeout, the merged
 * environment, and the exact-SHA clean assertions are exactly what they were,
 * and the behavioural suite below pins the shell-expression execution that
 * backs the new words — so a future change to the interpreter fails here
 * rather than in an Author's terminal.
 */
import { readFileSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verify } from "../src/git.js";
import { run } from "../src/process.js";
import { createTestRepository, type TestRepository } from "./helpers.js";

const REPO_ROOT = join(import.meta.dirname, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/** The one slice of the README a host requirement can legitimately live in. */
function readmeRequirementsSection(): string {
  const readme = readRepoFile("README.md");
  const start = readme.indexOf("## Requirements");
  expect(start, "README must keep a Requirements section").toBeGreaterThanOrEqual(0);
  const rest = readme.slice(start + "## Requirements".length);
  const end = rest.search(/\n##\s/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The prose of a JSONC document, with the `//` markers and the line wrapping
 * removed. The config template is a commented JSONC file, so a contract
 * sentence lives across several `//` lines; asserting it against the raw bytes
 * would pin the wrapping rather than the words, and re-wrapping a comment is
 * not a contract change. The words themselves stay exact.
 */
function jsoncCommentProse(relativePath: string): string {
  return readRepoFile(relativePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("//"))
    .map((line) => line.replace(/^\/\/\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The README sentence. It is pinned in full rather than by fragment because
 * every clause is load-bearing: the two operations that run verification, the
 * exact interpreter invocation, the working directory, the host that cannot
 * work, and the deliberate absence of a `package.json` `os` restriction and of
 * any fallback interpreter. A shortened or softened variant is the defect this
 * ticket exists to prevent.
 */
const README_POSIX_REQUIREMENT =
  "`poiesis verify` and the post-integration verification `poiesis integrate` runs execute every configured verification command as `/bin/sh -c <command>`, with the working directory set to the canonical Git root of the exact candidate being proven. A host with no `/bin/sh` — Windows, or a container image without a POSIX shell — cannot run verification, so this is a stated requirement rather than a `package.json` `os` restriction, and there is no PowerShell, `cmd.exe`, or `sh`-on-`PATH` fallback.";

/**
 * The COMPATIBILITY sentence. An integrator wiring an error handler needs to
 * know that BOTH command lists reach one interpreter, and that the working
 * directory is the canonical Git root of the candidate being proven — which is
 * the repository root for `verify` and a temporary detached worktree for
 * post-integration verification, not the primary checkout in both cases. The
 * final clause is what keeps the new words from reading as a warning that
 * evidence, timeouts, and clean assertions degrade elsewhere: they do not.
 */
const COMPATIBILITY_VERIFICATION_EXECUTION =
  "`verification.commands` and `verification.postIntegrationCommands` are shell command strings, not argument vectors, and both run through the same interpreter: Poiesis executes each one as `/bin/sh -c <command>`, with the working directory set to the canonical Git root of the exact candidate it is proving — the repository root for `poiesis verify`, and the temporary detached worktree Poiesis creates for the integrated commit for post-integration verification. The interpreter is that exact path: there is no PowerShell, `cmd.exe`, or `sh`-on-`PATH` route, so a host without `/bin/sh` cannot run verification and the requirement is documented in the README rather than declared as a `package.json` `os` restriction. Nothing else about the execution is host-dependent: the per-command timeout, the bounded stdout/stderr evidence, the exact-SHA clean assertions before and after, and the merged environment are identical on every host.";

/**
 * The template sentence. Both sources of command strings are named on purpose:
 * a string an Author writes and a string `init` copies out of `package.json`
 * are executed by the same interpreter, so a project whose existing scripts are
 * not POSIX-sh compatible fails verification the same way either way.
 */
const TEMPLATE_POSIX_COMPATIBLE =
  "Every string in this `verification` block is one POSIX-sh command line, not an argument vector: Poiesis executes it as `/bin/sh -c` with the working directory set to the canonical Git root of the exact candidate. So the strings configured here and the package-script strings `init` discovers from package.json must both be POSIX-sh compatible; the same rule covers `postIntegrationCommands` if you add that block.";

describe("README states the POSIX-shell requirement where a host reads it", () => {
  const requirements = readmeRequirementsSection();

  it("states the requirement in the requirements list, not somewhere an Author reads later", () => {
    expect(requirements).toContain(README_POSIX_REQUIREMENT);
  });

  it("names the requirement as a host requirement, not as a package-manager detail", () => {
    expect(requirements).toContain("**A POSIX host with `/bin/sh` at that exact path.**");
  });

  it("names both operations that execute a verification command", () => {
    // `poiesis verify` alone would leave the post-integration run of the same
    // strings undocumented, and that run is the one that happens inside a
    // worktree Poiesis created and then deletes.
    expect(requirements).toContain("`poiesis verify`");
    expect(requirements).toContain("the post-integration verification `poiesis integrate` runs");
  });

  it("offers no fallback interpreter and no implicit shell lookup", () => {
    // The tempting rewrite is "any POSIX shell on PATH". That is a different
    // guarantee: it would describe behaviour the runtime does not have, and it
    // is the sentence an integrator would rely on when a Windows host failed.
    expect(requirements).toContain("there is no PowerShell, `cmd.exe`, or `sh`-on-`PATH` fallback");
    expect(requirements).not.toContain("any POSIX shell on `PATH`");
    expect(requirements).not.toContain("any POSIX-compatible shell");
  });
});

describe("COMPATIBILITY states how both verification command lists are executed", () => {
  const compatibility = readRepoFile("COMPATIBILITY.md");

  it("names both command lists, the exact interpreter, and the canonical Git root", () => {
    expect(compatibility).toContain(COMPATIBILITY_VERIFICATION_EXECUTION);
  });

  it("places the contract inside process execution, where the other bounds are", () => {
    // The sentence sits under the execution bounds on purpose: the per-command
    // timeout and the output bounds apply to these commands too, and an
    // integrator reading that list should not have to find the interpreter in
    // a different section to know what the bounds apply to. Sliced from the
    // section heading to the NEXT heading, so this fails if the contract is
    // ever moved out from under the bounds it qualifies.
    const start = compatibility.indexOf("### Verification command execution");
    expect(start, "COMPATIBILITY must have a verification execution subsection").toBeGreaterThanOrEqual(0);
    const rest = compatibility.slice(start);
    const end = rest.slice("### Verification command execution".length).search(/\n#{1,3}\s/);
    const subsection = end === -1 ? rest : rest.slice(0, end + "### Verification command execution".length);
    expect(compatibility).toContain("## Process execution");
    expect(start).toBeGreaterThan(compatibility.indexOf("## Process execution"));
    expect(subsection).toContain("`/bin/sh -c <command>`");
    expect(subsection).toContain("canonical Git root");
  });

  it("distinguishes argument vectors from shell command strings", () => {
    // `delivery.<target>.command` really is an argument vector and is really
    // spawned directly; only the verification strings go through a shell. The
    // contrast is what stops an integrator from assuming the same route for
    // both, and it is the reason the template sentence is scoped to the
    // `verification` block.
    expect(compatibility).toContain("are shell command strings, not argument vectors");
  });

  it("preserves the evidence, timeout, clean, and environment guarantees on every host", () => {
    expect(compatibility).toContain(
      "the per-command timeout, the bounded stdout/stderr evidence, the exact-SHA clean assertions before and after, and the merged environment are identical on every host",
    );
  });
});

describe("the canonical config template states the authoring rule for both sources", () => {
  const template = readRepoFile("POIESIS_CONFIG_TEMPLATE.jsonc");
  const templateProse = jsoncCommentProse("POIESIS_CONFIG_TEMPLATE.jsonc");

  it("states that verification strings are POSIX-sh command lines", () => {
    expect(templateProse).toContain(TEMPLATE_POSIX_COMPATIBLE);
  });

  it("scopes the rule to the `verification` block so it is not read onto delivery argv", () => {
    // The delivery adapters above it take an argument vector and are spawned
    // directly. A sentence that simply said "every string in this file" would
    // be false for them; scoping it to the block is the smallest honest form.
    expect(templateProse).toContain("Every string in this `verification` block");
    expect(template).toContain('"verification": {');
  });

  it("still shows the command list an Author fills in", () => {
    expect(template).toContain('"commands": ["<authoritative-project-check-command>"]');
  });
});

describe("the implementation the documents describe is the implementation that runs", () => {
  it("spawns /bin/sh -c for a verification command", () => {
    // Ties the words to the seam. Whitespace-tolerant on purpose: the contract
    // is the argv shape, not the formatting of the line that spells it.
    //
    // Spec #168 / ticket #186 moved that argv out of `git.ts` and behind the
    // shared command-processor seam, because verification is only one of the
    // surfaces that runs arbitrary command text (`poiesis check` and
    // post-integration verification reach the same one), and on Windows the
    // processor is a validated `ComSpec` rather than a POSIX shell. The contract
    // is unchanged — the same `/bin/sh` with `["-c", <command>]` — so this pin
    // follows the seam to where it now lives and additionally asserts the
    // delegation, which is what stops a verification command from drifting onto
    // a different interpreter. `command-processor.test.ts` pins the same argv
    // behaviourally on the processor itself.
    expect(readRepoFile("src/git.ts")).toMatch(/runManagedShellCommand\(\{/);
    const processor = readRepoFile("src/command-processor.ts");
    expect(processor).toMatch(/POSIX_COMMAND_PROCESSOR\s*=\s*"\/bin\/sh"/);
    expect(processor).toMatch(/command:\s*POSIX_COMMAND_PROCESSOR,\s*args:\s*\["-c",\s*command\]/);
    expect(readRepoFile("src/managed-shell.ts")).toMatch(/run\(\s*processor\.command,\s*\[\.\.\.processor\.args\],/);
  });

  it("keeps the requirement documented rather than declared as a package restriction", () => {
    // An `os` field here would install-registry-block Windows installs, which
    // is a different product decision than stating a documented host
    // requirement, and it is not this ticket's decision to make.
    const manifest = JSON.parse(readRepoFile("package.json")) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty("os");
    expect(manifest).not.toHaveProperty("cpu");
    expect(manifest.engines).toEqual({ node: ">=22.20.0" });
  });
});

const repositories: TestRepository[] = [];

afterEach(async () => {
  while (repositories.length > 0) {
    await rm(repositories.pop()!.parent, { recursive: true, force: true });
  }
});

/**
 * The behavioural pin for everything the three documents now claim.
 *
 * Gated on a POSIX host because the contract itself is POSIX-only: on Windows
 * there is no `/bin/sh`, which is the whole point of the requirement rather
 * than a gap in the suite.
 */
describe.skipIf(process.platform === "win32")("Verify executes shell command lines, not argument vectors", () => {
  it(
    "interprets one configured string as a POSIX-sh command line and records its evidence",
    { timeout: 30000 },
    async () => {
      const repository = await createTestRepository();
      repositories.push(repository);

      // Assignment, `&&` lists, the `[` test builtin, command substitution,
      // parameter expansion with a default, and an explicit descriptor
      // redirection. A single `spawn` of this whole string as a program name
      // cannot produce the composed output below, so the evidence is proof
      // that a shell parsed it. `POIESIS_VERIFY_SHELL_TOKEN` also pins the
      // merged environment reaching the command, and `1>&2` pins that stdout
      // and stderr are still captured separately and separately bounded.
      const command =
        'token=${POIESIS_VERIFY_SHELL_TOKEN:-unset} && [ -n "$token" ] && printf "%s-%s" "$token" "$(printf sh)" 1>&2 && printf "%s" "$token"';

      const result = await verify({
        cwd: repository.root,
        candidateSha: repository.baseSha,
        commands: [command],
        env: { POIESIS_VERIFY_SHELL_TOKEN: "env-token" },
      });

      expect(result).toMatchObject({
        candidateSha: repository.baseSha,
        cleanBefore: true,
        cleanAfter: true,
      });
      expect(result.commands).toEqual([
        {
          command,
          exitCode: 0,
          stdout: "env-token",
          stderr: "env-token-sh",
        },
      ]);
    },
  );

  it(
    "runs from the canonical Git root even when Verify is invoked from a subdirectory",
    { timeout: 30000 },
    async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      await mkdir(join(repository.root, "nested"));
      await writeFile(join(repository.root, "nested", "tracked.txt"), "tracked\n", "utf8");
      await run("git", ["add", "--all"], { cwd: repository.root });
      await run("git", ["commit", "--quiet", "-m", "nested"], { cwd: repository.root });
      const candidateSha = (await run("git", ["rev-parse", "HEAD"], { cwd: repository.root })).stdout.trim();
      // The canonical root is the realpath of the Git toplevel, so the
      // comparison has to be against the realpath too: on a host where the
      // temporary directory is a symlink, the literal `repository.root` is not
      // what the working directory is.
      const canonicalRoot = await realpath(repository.root);

      // `test -f README.md` is the decisive half: the tracked README exists at
      // the root and not under `nested/`, so a working directory left at the
      // invocation directory would fail the `&&` list instead of printing.
      const command = 'test -f README.md && printf "%s:%s" "$(pwd -P)" "$(cat README.md)"';
      const result = await verify({
        cwd: join(repository.root, "nested"),
        candidateSha,
        commands: [command],
      });

      expect(result).toMatchObject({ candidateSha, cleanBefore: true, cleanAfter: true });
      expect(result.commands).toEqual([
        {
          command,
          exitCode: 0,
          // Command substitution strips the trailing newline `cat` emitted, so
          // the tracked file's content arrives without it.
          stdout: `${canonicalRoot}:fixture`,
          stderr: "",
        },
      ]);
    },
  );

  it(
    "keeps the clean-after guarantee when a shell expression dirties the candidate",
    { timeout: 30000 },
    async () => {
      // The `&&` form is what makes this a shell claim rather than a program
      // claim, and the refusal is what says the interpreter did not give the
      // command any privilege over the exact-SHA clean assertions.
      const repository = await createTestRepository();
      repositories.push(repository);

      await expect(
        verify({
          cwd: repository.root,
          candidateSha: repository.baseSha,
          commands: ['printf "residue\\n" > README.md && printf "%s" unreachable'],
        }),
      ).rejects.toMatchObject({
        code: "DIRTY_CANDIDATE",
        details: {
          candidateSha: repository.baseSha,
          commands: [{ command: 'printf "residue\\n" > README.md && printf "%s" unreachable', exitCode: 0 }],
          status: [" M README.md"],
        },
      });
    },
  );
});

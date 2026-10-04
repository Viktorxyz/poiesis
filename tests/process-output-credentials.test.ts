/**
 * Spec #139 / ticket #149 — a URL userinfo credential that a SUBPROCESS
 * prints is never returned by the process runner, on any path.
 *
 * Ticket #146 redacted the credential in a URL Poiesis itself parsed (a
 * configured remote). It left the other, larger surface open: the runner
 * returns raw subprocess stdout/stderr, and a failing `git` / `gh` /
 * `glab` / verification command prints the credential-bearing URL back to
 * the caller — `fatal: unable to access 'https://user:token@host/…': …`.
 * That text reaches a returned result, a `COMMAND_FAILED` detail, a
 * `COMMAND_TIMEOUT` detail, a doctor report, a proof, and a published
 * evidence file, because the process runner is the ONE seam every
 * subprocess output passes through.
 *
 * So the redaction is applied centrally, at the process runner, on both
 * streams, for every settlement path (success, `allowFailure`,
 * `COMMAND_FAILED`, `COMMAND_TIMEOUT`, and a byte-cap truncation). The
 * rule is a redaction, not a rewrite: scheme, host, port, path, query,
 * fragment, and every surrounding byte survive; a credential-free URL, an
 * scp-style SSH remote, an email address, and an `@` inside a path are
 * left exactly as the child wrote them.
 *
 * The one place the runner cannot know the answer is a capture that was
 * TRUNCATED inside a possible `scheme://authority`. There the `@` that
 * proves userinfo may itself be in the dropped bytes, so the runner fails
 * closed and withholds the partial authority rather than exposing a
 * partial userinfo.
 *
 * The sentinel below exists only in this file. Assertions are written
 * against the FULL serialization of each surface (`JSON.stringify` of the
 * result / error / CLI envelope), so a test that forgets a surface leaves
 * that surface's leak undetected. The last two suites run the real `git`
 * and the real built bundle, because the shipped CLI — not only the
 * TypeScript source — is the surface an Author sees.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { asPoiesisError } from "../src/errors.js";
import { run } from "../src/process.js";
import { sanitizeSubprocessOutput } from "../src/url-userinfo.js";
import { createTestRepository, type TestRepository } from "./helpers.js";

/** A credential that exists only in this test file. */
const SENTINEL_SECRET = "ghp_POIESIS_T149_SENTINEL_c7e2b48f0a1d";

/**
 * Two different credential-bearing URLs so a test that only covers one
 * stream cannot pass by inspecting the other. The stderr URL is `ssh://`
 * to prove the rule is not an HTTPS-only special case.
 */
const STDOUT_URL = `https://build-bot:${SENTINEL_SECRET}@127.0.0.1:1/team/repo.git`;
const STDERR_URL = `ssh://ci-bot:${SENTINEL_SECRET}@internal.example/team/repo.git`;
const SANITIZED_STDOUT_URL = "https://127.0.0.1:1/team/repo.git";
const SANITIZED_STDERR_URL = "ssh://internal.example/team/repo.git";

/**
 * A credential-bearing remote on a refused loopback port, so a real
 * `git` command against it fails immediately and offline with the URL it
 * was given in its own stderr.
 */
const CREDENTIAL_REMOTE = `https://build-bot:${SENTINEL_SECRET}@127.0.0.1:1/team/repo.git`;

/** The serialized CLI failure envelope, byte-identical to `writeFailure`. */
function failureJson(error: unknown): string {
  const normalized = asPoiesisError(error);
  return JSON.stringify(
    { ok: false, error: { code: normalized.code, message: normalized.message, details: normalized.details } },
    null,
    2,
  );
}

const fixtures: string[] = [];
const repositories: TestRepository[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    await rm(fixtures.pop()!, { recursive: true, force: true });
  }
  while (repositories.length > 0) {
    await rm(repositories.pop()!.parent, { recursive: true, force: true });
  }
});

async function stageScript(content: string): Promise<{ dir: string; script: string }> {
  const dir = await mkdtemp(join(tmpdir(), "poiesis-t149-"));
  fixtures.push(dir);
  const script = join(dir, "case.sh");
  await writeFile(script, content, "utf8");
  await chmod(script, 0o755);
  return { dir, script };
}

async function repositoryWithCredentialRemote(): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  await run("git", ["remote", "set-url", "origin", CREDENTIAL_REMOTE], { cwd: repository.root });
  return repository;
}

/**
 * A config whose single verification command is a REAL `git` invocation
 * that reports the remote and then fails against it, so the failure
 * envelope an Author sees is built from real Git output — and that output
 * is what carries the credential-bearing URL.
 */
async function writePushVerificationConfig(root: string): Promise<string> {
  await mkdir(join(root, ".poiesis"), { recursive: true });
  await writeFile(
    join(root, ".poiesis", "config.jsonc"),
    `${JSON.stringify(
      {
        schema: 1,
        models: { reasoning: "openai/gpt-5.6-sol", execution: "minimax/MiniMax-M3" },
        repository: { remote: "origin", integrationBranch: "main" },
        tracker: { provider: "local" },
        verification: { commands: ["git remote -v && git push origin main"] },
      },
      null,
      2,
    )}\n`,
  );
  // The config is part of the candidate the command verifies, so it is
  // committed: an uncommitted file would fail the clean-workspace gate
  // before the verification command ever ran.
  await run("git", ["add", ".poiesis/config.jsonc"], { cwd: root });
  await run("git", ["commit", "-q", "-m", "verification config"], { cwd: root });
  return (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout;
}

describe("the one URL userinfo rule (Spec #139 / ticket #149)", () => {
  it("keeps the scheme, host, port, path, query and fragment around a removed userinfo", () => {
    const line = `fatal: unable to access 'https://build-bot:${SENTINEL_SECRET}@internal.example:8443/team/repo.git?ref=main#notes': denied`;
    expect(sanitizeSubprocessOutput(line)).toBe(
      "fatal: unable to access 'https://internal.example:8443/team/repo.git?ref=main#notes': denied",
    );
  });

  it("removes a userinfo whose secret itself contains an `@`", () => {
    expect(sanitizeSubprocessOutput("cloning https://user:p@ss@github.com/owner/repo.git")).toBe(
      "cloning https://github.com/owner/repo.git",
    );
  });

  it("stops the authority at whitespace when the URL has no path", () => {
    expect(sanitizeSubprocessOutput(`cannot reach https://build-bot:${SENTINEL_SECRET}@internal.example, retrying`)).toBe(
      "cannot reach https://internal.example, retrying",
    );
  });

  it("removes the userinfo of a pathless URL that is adjacent to another one", () => {
    expect(sanitizeSubprocessOutput("remotes https://a:one@host1,https://b:two@host2")).toBe(
      "remotes https://host1,https://host2",
    );
  });

  it("removes the userinfo of both URLs in compact JSON", () => {
    expect(sanitizeSubprocessOutput('{"remote":"https://a:one@host1","mirror":"https://b:two@host2"}')).toBe(
      '{"remote":"https://host1","mirror":"https://host2"}',
    );
  });

  it("removes the userinfo from every URL of a multi-line block and leaves the other lines byte-for-byte", () => {
    const block = [
      "remote 1 https://build-bot:one@one.example/team/one.git",
      "contact owner@example.com and scp git@github.com:owner/repo.git",
      "remote 2 https://ci-bot:two@two.example/team/two.git",
    ].join("\n");
    expect(sanitizeSubprocessOutput(block)).toBe(
      [
        "remote 1 https://one.example/team/one.git",
        "contact owner@example.com and scp git@github.com:owner/repo.git",
        "remote 2 https://two.example/team/two.git",
      ].join("\n"),
    );
  });

  it("leaves a credential-free URL, an `@` in a path, an scp form and an email alone", () => {
    const text = "https://github.com/owner/repo.git https://github.com/own@er/repo.git git@github.com:owner/repo.git owner@example.com";
    expect(sanitizeSubprocessOutput(text)).toBe(text);
  });

  it("keeps a credential-free URL that ends a complete capture", () => {
    expect(sanitizeSubprocessOutput("cloning https://github.com/owner/repo.git")).toBe(
      "cloning https://github.com/owner/repo.git",
    );
    expect(sanitizeSubprocessOutput("cloning https://github.com/owner/repo.git", { truncated: true })).toBe(
      "cloning https://github.com/owner/repo.git",
    );
  });

  it("withholds a possible authority that truncation left unterminated", () => {
    expect(sanitizeSubprocessOutput("cloning https://build-bot:ghp_partial", { truncated: true })).toBe(
      "cloning https://[redacted]",
    );
  });
});

/**
 * The scanner's own cases. Each one names a break: an adjacency the
 * authority run must split at, a terminator it must not treat as one, or
 * the fail-closed rule for a capture the byte cap cut. The secrets are
 * short literals because the point of each case is the STRUCTURE around
 * them — where one URL ends and the next begins — not the credential.
 */
describe("the single-pass scanner (Spec #139 / ticket #149)", () => {
  it("removes the userinfo of the second URL of a pair, which the first one's authority run swallowed", () => {
    expect(sanitizeSubprocessOutput("remotes https://host1,https://a:b@host2")).toBe(
      "remotes https://host1,https://host2",
    );
  });

  it("removes the userinfo of the first URL of a pair whose second one is credential-free", () => {
    expect(sanitizeSubprocessOutput("remotes https://a:b@host1,https://host2")).toBe(
      "remotes https://host1,https://host2",
    );
  });

  it("removes the userinfo of every URL in a three-URL chain of mixed schemes", () => {
    expect(
      sanitizeSubprocessOutput("a https://one:tok1@h1, ssh://two:tok2@h2, git+ssh://three:tok3@h3/path b"),
    ).toBe("a https://h1, ssh://h2, git+ssh://h3/path b");
  });

  it("removes the userinfo of three URLs in compact JSON and keeps the JSON bytes", () => {
    expect(
      sanitizeSubprocessOutput('{"a":"https://u1:p1@h1","b":"ssh://u2:p2@h2","c":"git://u3:p3@h3"}'),
    ).toBe('{"a":"https://h1","b":"ssh://h2","c":"git://h3"}');
  });

  it("keeps LF and CRLF line structure byte-for-byte while removing userinfo on each line", () => {
    // The email and the `x@y` are the load-bearing part: they open the line
    // right after a break, so an authority that ran across the break would
    // reach their `@` and withhold the block up to it.
    expect(
      sanitizeSubprocessOutput(
        "fetch https://a:one@h1\nowner@example.com\npush ssh://b:two@h2\r\nx@y\r\ndone https://c:three@h3",
      ),
    ).toBe("fetch https://h1\nowner@example.com\npush ssh://h2\r\nx@y\r\ndone https://h3");
  });

  it("keeps an `@` in the path, the query and the fragment of a credential-bearing URL", () => {
    expect(sanitizeSubprocessOutput("git clone https://u:p@host/pa@th?q=a@b#f@g")).toBe(
      "git clone https://host/pa@th?q=a@b#f@g",
    );
  });

  it("ends an authority at a non-ASCII space and a line separator, as it does at a space", () => {
    // The `@` of `second@third` sits after the separator, so an authority
    // that ran across it would be withheld up to that `@` — taking the
    // surrounding diagnostic with it.
    expect(
      sanitizeSubprocessOutput("first\u00a0https://u:p@host\u2028second@third https://v:w@host2"),
    ).toBe("first\u00a0https://host\u2028second@third https://host2");
  });

  it("reads a scheme-shaped run that starts an authority as a URL of its own", () => {
    expect(sanitizeSubprocessOutput("https://aX://b@host")).toBe("https://aX://host");
  });

  it("removes a userinfo that holds several `@` characters", () => {
    expect(sanitizeSubprocessOutput("https://a@b@c@d@host/p")).toBe("https://host/p");
  });

  it("removes the userinfo of a URL nested inside another URL's userinfo", () => {
    expect(sanitizeSubprocessOutput("https://a:b@x://c:d@host")).toBe("https://x://host");
  });

  it("withholds the whole captured authority of a truncated capture that ended after an `@`", () => {
    expect(sanitizeSubprocessOutput("cloning https://build-bot:ghp_part@internal.ex", { truncated: true })).toBe(
      "cloning https://[redacted]",
    );
  });

  it("withholds an apparently credential-free authority that a truncated capture left open", () => {
    expect(sanitizeSubprocessOutput("cloning https://internal.example", { truncated: true })).toBe(
      "cloning https://[redacted]",
    );
  });

  it("keeps an authority that is credential-free and open at the end of a complete capture", () => {
    expect(sanitizeSubprocessOutput("cloning https://internal.example")).toBe("cloning https://internal.example");
  });

  it("keeps a completed authority of a truncated capture and withholds only its userinfo", () => {
    expect(sanitizeSubprocessOutput("fetch https://u:p@host/p/q", { truncated: true })).toBe(
      "fetch https://host/p/q",
    );
  });

  it("appends nothing for a scheme that truncation cut with no authority bytes captured", () => {
    expect(sanitizeSubprocessOutput("cloning https://", { truncated: true })).toBe("cloning https://");
  });

  it("returns the same text when the rule runs again over its own output", () => {
    const inputs = [
      "remotes https://host1,https://a:b@host2",
      "a https://one:tok1@h1, ssh://two:tok2@h2, git+ssh://three:tok3@h3/path b",
      "cloning https://internal.example",
      "cloning https://build-bot:ghp_part@internal.ex",
      "fetch https://u:p@host/p/q",
    ];
    for (const input of inputs) {
      for (const truncated of [false, true]) {
        const once = sanitizeSubprocessOutput(input, { truncated });
        expect(sanitizeSubprocessOutput(once, { truncated })).toBe(once);
      }
    }
  });
});

describe("the process runner seam (Spec #139 / ticket #149)", () => {
  it("removes URL userinfo from both streams of a successful command", async () => {
    const { script } = await stageScript(
      `#!/bin/sh\nprintf 'cloning %s\\n' '${STDOUT_URL}'\nprintf 'fatal: unable to reach %s\\n' '${STDERR_URL}' 1>&2\n`,
    );
    const result = await run(script, [], { cwd: tmpdir() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`cloning ${SANITIZED_STDOUT_URL}`);
    expect(result.stderr).toBe(`fatal: unable to reach ${SANITIZED_STDERR_URL}`);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_SECRET);
  });

  it("removes URL userinfo when a non-zero exit is returned as a result", async () => {
    const { script } = await stageScript(
      `#!/bin/sh\nprintf 'fatal: unable to reach %s\\n' '${STDERR_URL}' 1>&2\nexit 7\n`,
    );
    const result = await run(script, [], { cwd: tmpdir(), allowFailure: true });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe(`fatal: unable to reach ${SANITIZED_STDERR_URL}`);
    expect(result.stderr).not.toContain(SENTINEL_SECRET);
  });

  it("removes URL userinfo from the COMMAND_FAILED rejection details", async () => {
    const { script } = await stageScript(
      `#!/bin/sh\nprintf 'fatal: unable to access %s\\n' '${STDOUT_URL}' 1>&2\nexit 128\n`,
    );
    const error = await run(script, [], { cwd: tmpdir() }).catch((thrown: unknown) => thrown);
    const normalized = asPoiesisError(error);
    expect(normalized.code).toBe("COMMAND_FAILED");
    expect(normalized.details.exitCode).toBe(128);
    expect(normalized.details.stderr).toBe(`fatal: unable to access ${SANITIZED_STDOUT_URL}`);
    expect(failureJson(error)).toContain(SANITIZED_STDOUT_URL);
    expect(failureJson(error)).not.toContain(SENTINEL_SECRET);
  });

  it("removes URL userinfo from the COMMAND_TIMEOUT details", { timeout: 30_000 }, async () => {
    const { script } = await stageScript(`#!/bin/sh\nprintf 'cloning %s\\n' '${STDOUT_URL}'\nsleep 30\n`);
    const error = await run(script, [], { cwd: tmpdir(), timeoutMs: 500 }).catch((thrown: unknown) => thrown);
    const normalized = asPoiesisError(error);
    expect(normalized.code).toBe("COMMAND_TIMEOUT");
    expect(normalized.exitCode).toBe(124);
    expect(normalized.details.stdoutTruncated).toBe(false);
    expect(normalized.details.stdout).toBe(`cloning ${SANITIZED_STDOUT_URL}`);
    expect(failureJson(error)).not.toContain(SENTINEL_SECRET);
  });

  it("withholds a partial authority that the byte cap truncated", async () => {
    // 40 filler bytes + "https://build-bot:" (19 bytes) + 6 bytes of the
    // secret: the capture ends inside the possible userinfo, before the
    // `@` that would prove one is there.
    const maxBytes = 65;
    const filler = "x".repeat(40);
    const { script } = await stageScript(
      `#!/bin/sh\nprintf '%s' '${filler}${STDOUT_URL} trailing text that the cap drops'\n`,
    );
    const result = await run(script, [], { cwd: tmpdir(), maxBytes });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toBe(`${filler}https://[redacted]`);
    expect(result.stdout).not.toContain("ghp_");
    expect(result.stdout).not.toContain("build-bot");
  });

  it("removes the userinfo of a second URL printed next to a first one on the same line", async () => {
    // The first URL has no path, so its authority run reaches into the
    // second URL: the shape that hides a credential from a rule which only
    // looks at each authority as one run.
    const adjacent = `https://127.0.0.1:1,https://build-bot:${SENTINEL_SECRET}@127.0.0.1:2/team/other.git`;
    const { script } = await stageScript(
      `#!/bin/sh\nprintf 'hosts %s\\n' '${adjacent}'\nprintf 'hosts %s\\n' '${adjacent}' 1>&2\n`,
    );
    const result = await run(script, [], { cwd: tmpdir() });
    expect(result.stdout).toBe("hosts https://127.0.0.1:1,https://127.0.0.1:2/team/other.git");
    expect(result.stderr).toBe("hosts https://127.0.0.1:1,https://127.0.0.1:2/team/other.git");
    expect(JSON.stringify(result)).not.toContain(SENTINEL_SECRET);
  });
});

describe("real Git output", () => {
  it("removes the remote credential from the URLs Git itself prints", { timeout: 30_000 }, async () => {
    const repository = await repositoryWithCredentialRemote();
    const result = await run("git", ["remote", "-v"], { cwd: repository.root });
    expect(result.stdout).toBe(
      [
        `origin\t${SANITIZED_STDOUT_URL} (fetch)`,
        `origin\t${SANITIZED_STDOUT_URL} (push)`,
      ].join("\n"),
    );
    expect(result.stdout).not.toContain(SENTINEL_SECRET);
  });
});

/**
 * The built package, not the source: the shipped bundle is what an Author
 * runs, so a source-only guarantee would leave the CLI free to print the
 * credential. The bundle is built into a dedicated out-dir so it cannot
 * race the suites that own `dist/`.
 */
describe("the built package never prints a subprocess credential", () => {
  const outDir = "dist-ticket-149";
  let cliPath: string | undefined;

  beforeAll(async () => {
    const repoRoot = join(import.meta.dirname, "..");
    await run(
      "node",
      ["node_modules/tsup/dist/cli-default.js", "src/cli.ts", "--format", "esm", "--clean", "--no-dts", "--out-dir", outDir],
      { cwd: repoRoot, timeoutMs: 120_000 },
    );
    const built = join(repoRoot, outDir, "cli.js");
    if (!existsSync(built)) throw new Error(`tsup did not produce ${built}`);
    cliPath = built;
  }, 120_000);

  afterAll(async () => {
    // Only remove the dedicated out-dir; never touch dist/.
    await rm(join(import.meta.dirname, "..", outDir), { recursive: true, force: true });
  });

  it("keeps the credential out of a verification failure built from real Git output", { timeout: 60_000 }, async () => {
    if (cliPath === undefined) throw new Error("cli not built");
    const cli = cliPath;
    const repository = await repositoryWithCredentialRemote();
    const candidateSha = await writePushVerificationConfig(repository.root);

    const verification = await run("node", [cli, "verify", "--sha", candidateSha], {
      cwd: repository.root,
      allowFailure: true,
      timeoutMs: 30_000,
    });
    expect(verification.exitCode).not.toBe(0);
    expect(verification.stderr).toContain("VERIFICATION_FAILED");
    expect(verification.stderr).toContain(SANITIZED_STDOUT_URL);
    expect(verification.stderr).not.toContain(SENTINEL_SECRET);
  });
});

import { accessSync, constants, statSync } from "node:fs";
import { win32 } from "node:path";
import { PoiesisError } from "./errors.js";

/**
 * Spec #168 / ticket #176 — the ONE platform-aware command-processor seam.
 *
 * Verify and Focused Check execute caller-supplied COMMAND TEXT, which needs a
 * processor to interpret it. Before this seam that processor was a hardcoded
 * `/bin/sh`, which does not exist on Windows, cannot be validated, and turns a
 * missing interpreter into an opaque spawn failure.
 *
 * The contract is deliberately narrow:
 *   - POSIX:    `/bin/sh` with `["-c", <the exact command>]`
 *   - Windows:  a validated absolute `ComSpec` naming `cmd.exe`, with
 *               `["/d", "/s", "/c", <the exact command>]`
 *   - the command is never mutated, quoted, or rewritten;
 *   - there is no `shell: true`, no PowerShell, and no fallback processor.
 *
 * Every rejection is raised BEFORE a process exists and is a typed,
 * actionable infrastructure failure: a caller can fix it, and a failing check
 * classifies exactly as it did before (the closed classification vocabulary is
 * unchanged).
 */

/** The POSIX processor. A constant, because POSIX has exactly one `/bin/sh`. */
export const POSIX_COMMAND_PROCESSOR = "/bin/sh";

/** The only Windows processor Poiesis will drive. */
export const WINDOWS_COMMAND_PROCESSOR = "cmd.exe";

export type CommandProcessorUnavailableReason =
  | "PROCESSOR_NOT_EXECUTABLE"
  | "COMSPEC_MISSING"
  | "COMSPEC_NOT_ABSOLUTE"
  | "COMSPEC_NOT_COMMAND_PROCESSOR"
  | "COMSPEC_UNAVAILABLE";

export interface CommandProcessorInvocation {
  /** Absolute path of the processor to execute. */
  readonly command: string;
  /** Its argv, including the exact command text as the last element. */
  readonly args: readonly string[];
}

/**
 * The seams `buildCommandProcessorInvocation` reads the host through.
 *
 * `isFile` exists so a Windows-shaped `ComSpec` such as
 * `C:\Windows\System32\cmd.exe` can be validated on a host where that path does
 * not exist. It changes WHAT is inspected, never WHAT is accepted: the default
 * is a real `stat`, and a caller can only make the check stricter or run it
 * against a fixture.
 */
export interface CommandProcessorProbe {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Defaults to `statSync(path).isFile()`. */
  isFile?: (path: string) => boolean;
}

/**
 * Resolve the processor invocation for one command on one platform.
 *
 * @throws `COMMAND_PROCESSOR_UNAVAILABLE` when no usable processor exists.
 */
export function buildCommandProcessorInvocation(
  command: string,
  context: CommandProcessorProbe = {},
): CommandProcessorInvocation {
  const platform = context.platform ?? process.platform;
  if (platform === "win32") return windowsInvocation(command, platform, context);
  return posixInvocation(command, platform);
}

function posixInvocation(command: string, platform: NodeJS.Platform): CommandProcessorInvocation {
  try {
    accessSync(POSIX_COMMAND_PROCESSOR, constants.X_OK);
  } catch {
    throw processorUnavailable(
      platform,
      POSIX_COMMAND_PROCESSOR,
      "PROCESSOR_NOT_EXECUTABLE",
      `${POSIX_COMMAND_PROCESSOR} is not an executable file on this host, so no command text can be interpreted.`,
    );
  }
  return { command: POSIX_COMMAND_PROCESSOR, args: ["-c", command] };
}

function windowsInvocation(
  command: string,
  platform: NodeJS.Platform,
  context: CommandProcessorProbe,
): CommandProcessorInvocation {
  const env = context.env ?? process.env;
  const comSpec = env.ComSpec ?? env.COMSPEC;
  if (typeof comSpec !== "string" || comSpec.trim().length === 0) {
    throw processorUnavailable(
      platform,
      WINDOWS_COMMAND_PROCESSOR,
      "COMSPEC_MISSING",
      "ComSpec is not set, so the Windows command processor cannot be identified.",
      "Set ComSpec to an absolute path such as C:\\Windows\\System32\\cmd.exe.",
    );
  }
  const value = comSpec.trim();
  if (!win32.isAbsolute(value)) {
    throw processorUnavailable(
      platform,
      WINDOWS_COMMAND_PROCESSOR,
      "COMSPEC_NOT_ABSOLUTE",
      `ComSpec "${value}" is not absolute, so Poiesis would have to resolve it through PATH before it could be trusted.`,
      "Set ComSpec to an absolute path such as C:\\Windows\\System32\\cmd.exe.",
    );
  }
  // WINDOWS path semantics, always. A POSIX `basename` on `C:\Windows\System32
  // \cmd.exe` returns the whole string, which would refuse the one value that
  // is actually correct on the platform this branch exists for.
  const leaf = win32.basename(value);
  if (leaf.toLowerCase() !== WINDOWS_COMMAND_PROCESSOR) {
    throw processorUnavailable(
      platform,
      WINDOWS_COMMAND_PROCESSOR,
      "COMSPEC_NOT_COMMAND_PROCESSOR",
      `ComSpec names ${leaf}, which is not ${WINDOWS_COMMAND_PROCESSOR}; Poiesis drives only the Windows command processor.`,
      `Set ComSpec to an absolute path ending in ${WINDOWS_COMMAND_PROCESSOR}.`,
    );
  }
  let isFile = false;
  try {
    isFile = context.isFile === undefined ? statSync(value).isFile() : context.isFile(value);
  } catch {
    isFile = false;
  }
  if (!isFile) {
    throw processorUnavailable(
      platform,
      value,
      "COMSPEC_UNAVAILABLE",
      `ComSpec "${value}" is not a readable file on this host.`,
      "Point ComSpec at the real Windows command processor for this installation.",
    );
  }
  return { command: value, args: ["/d", "/s", "/c", command] };
}

/**
 * The single typed failure shape for "no usable processor on this host".
 * Infrastructure, actionable, and always raised before a spawn.
 */
function processorUnavailable(
  platform: NodeJS.Platform,
  processor: string,
  reason: CommandProcessorUnavailableReason,
  detail: string,
  remediation = "Restore a usable command processor on this host.",
): PoiesisError {
  return new PoiesisError(
    "COMMAND_PROCESSOR_UNAVAILABLE",
    `No usable command processor for platform ${platform}: ${detail}`,
    { reason, platform, processor, detail, remediation },
  );
}
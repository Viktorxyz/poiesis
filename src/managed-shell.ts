import { buildCommandProcessorInvocation } from "./command-processor.js";
import { STRONG_CONTAINMENT_MODEL } from "./containment.js";
import { run, type RunResult } from "./process.js";

/**
 * Spec #168 / ticket #176 — the ONE seam for arbitrary managed command text.
 *
 * `run()` is the low-level subprocess seam and its contract is a FIXED argv
 * with process-group isolation. That is exactly right for `git`, `gh`, `uv`,
 * `opencode`, and the delivery executables: Poiesis chooses those argv vectors
 * and nothing in them is caller-supplied text.
 *
 * It is not right for Verify and Focused Check, which execute arbitrary command
 * TEXT through a shell. That surface can `setsid` a descendant out of any
 * process group, so it gets two things `run()` alone does not provide:
 *
 *   1. the platform-aware command processor from `src/command-processor.ts`,
 *      resolved and validated before anything is spawned; and
 *   2. the strong containment from `src/containment.ts` — a delegated cgroup v2
 *      leaf entered through a Poiesis-owned admission prologue that confirms its
 *      own membership before any caller text can run. That refusal happens
 *      before the spawn when the host has no such capability at all.
 *
 * Both Spec #168 managed command paths go through here, so neither can drift
 * into its own processor or containment policy.
 */

export interface ManagedShellCommandOptions {
  cwd: string;
  /** The exact command text to interpret. It is never mutated. */
  command: string;
  /** Names the transient managed lease and the provisioned boundary. */
  operationId?: string;
  /** Poiesis ownership identity of the workspace, when one was proven. */
  workspaceId?: string;
  timeoutMs?: number;
  maxBytes?: number;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export async function runManagedShellCommand(options: ManagedShellCommandOptions): Promise<RunResult> {
  // The processor is resolved and validated BEFORE anything is spawned: a host
  // with no usable interpreter fails here, not as an opaque spawn error. It is
  // resolved against the merged child environment, so the processor is chosen
  // from exactly the environment the processor itself will see.
  const childEnvironment = options.env === undefined ? undefined : { ...process.env, ...options.env };
  const processor = buildCommandProcessorInvocation(options.command, {
    platform: process.platform,
    ...(childEnvironment === undefined ? {} : { env: childEnvironment }),
  });
  return await run(processor.command, [...processor.args], {
    cwd: options.cwd,
    allowFailure: options.allowFailure ?? false,
    // Arbitrary command text is the surface that must not run without absolute
    // containment. Containment is requested through `run()`'s own option rather
    // than imposed here, so the refusal — and the "nothing was created"
    // guarantee that comes with it — is produced by the one place that owns the
    // spawn.
    containment: STRONG_CONTAINMENT_MODEL,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
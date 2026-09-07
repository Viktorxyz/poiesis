import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { parseJsonc } from "./config.js";
import { PoiesisError } from "./errors.js";
import { exists, readUtf8 } from "./fs.js";
import { hashDirectory, pathKind } from "./hash.js";
import type { ManagedSkill } from "./manifest.js";
import { loadManifest, serializeManifest } from "./manifest.js";
import { packageRoot } from "./paths.js";
import { poiesisPath } from "./paths.js";
import { atomicWrite } from "./fs.js";
import { run } from "./process.js";

export const SKILLS_CLI_VERSION = "1.5.24";
export const SKILLS_DIRECTORY = ".agents/skills";
export const MATT_SKILLS_REVISION = "3cca18b368ae95cdbdebbff572ccafa662551015";
export const SUPERPOWERS_REVISION = "b36e0829c6d0140e93cfef2ca599b1b07d4a7797";

export interface DefaultSkill {
  source: string;
  name: string;
  revision: string;
}

export interface SkillMaintenanceOptions {
  replaceOwned?: boolean;
}

export interface SkillRemovalResult {
  removed: string[];
  preserved: Array<{ path: string; reason: string }>;
}

export interface CapabilityInstallInput {
  source: string;
  name: string;
  revision: string;
}

const sourceRevisions: Readonly<Record<string, string>> = {
  "mattpocock/skills": MATT_SKILLS_REVISION,
  "obra/superpowers": SUPERPOWERS_REVISION,
};

interface SkillsMetadata {
  schema: number;
  defaults: Array<{ source: string; name: string }>;
}

function isSkillsMetadata(value: unknown): value is SkillsMetadata {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SkillsMetadata>;
  return (
    candidate.schema === 1 &&
    Array.isArray(candidate.defaults) &&
    candidate.defaults.every(
      (skill) =>
        typeof skill === "object" &&
        skill !== null &&
        typeof skill.source === "string" &&
        skill.source.length > 0 &&
        typeof skill.name === "string" &&
        /^[a-z0-9][a-z0-9-]*$/.test(skill.name),
    )
  );
}

export function skillPath(root: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new PoiesisError("INVALID_SKILL_NAME", "Skill name is not a safe exact directory name", { name });
  }
  return join(root, SKILLS_DIRECTORY, name);
}

export async function loadDefaultSkills(): Promise<DefaultSkill[]> {
  const metadataPath = join(packageRoot, "POIESIS_SKILLS.json");
  const metadata = parseJsonc<unknown>(await readUtf8(metadataPath), metadataPath);
  if (!isSkillsMetadata(metadata)) {
    throw new PoiesisError("INVALID_SKILLS_METADATA", `Invalid skills metadata in ${metadataPath}`);
  }

  const seen = new Set<string>();
  return metadata.defaults.map(({ source, name }) => {
    const revision = sourceRevisions[source];
    if (revision === undefined) {
      throw new PoiesisError("UNPINNED_SKILL_SOURCE", "Default skill source has no pinned revision", {
        source,
        name,
      });
    }
    if (seen.has(name)) {
      throw new PoiesisError("DUPLICATE_DEFAULT_SKILL", "Default skill names must be unique", { name });
    }
    seen.add(name);
    return { source, name, revision };
  });
}

/** Builds the exact non-interactive CLI arguments used for one pinned source group. */
export function skillInstallArgs(source: string, revision: string, names: string[]): string[] {
  if (names.length === 0 || names.some((name) => !/^[a-z0-9][a-z0-9-]*$/.test(name))) {
    throw new PoiesisError("INVALID_SKILL_SELECTION", "At least one exact skill name is required", { names });
  }
  return [
    "--yes",
    `skills@${SKILLS_CLI_VERSION}`,
    "add",
    `${source}#${revision}`,
    "--skill",
    ...names,
    "--agent",
    "opencode",
    "--copy",
    "--yes",
  ];
}

async function stageSkills(skills: DefaultSkill[]): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const stagingRoot = await mkdtemp(join(tmpdir(), "poiesis-skills-"));
  try {
    await run("git", ["init", "--quiet"], { cwd: stagingRoot });
    const bySource = new Map<string, DefaultSkill[]>();
    for (const skill of skills) {
      const key = `${skill.source}\0${skill.revision}`;
      bySource.set(key, [...(bySource.get(key) ?? []), skill]);
    }
    for (const sourceSkills of bySource.values()) {
      const first = sourceSkills[0]!;
      await run(
        "npx",
        skillInstallArgs(
          first.source,
          first.revision,
          sourceSkills.map((skill) => skill.name),
        ),
        {
          cwd: stagingRoot,
          env: { DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" },
        },
      );
    }

    for (const skill of skills) {
      const stagedPath = skillPath(stagingRoot, skill.name);
      if (!(await exists(stagedPath)) || (await pathKind(stagedPath)) !== "directory") {
        throw new PoiesisError("SKILL_INSTALL_INCOMPLETE", "The skills CLI did not install an exact requested skill", {
          source: skill.source,
          name: skill.name,
          revision: skill.revision,
        });
      }
    }
    return { root: stagingRoot, cleanup: () => rm(stagingRoot, { recursive: true, force: true }) };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function installDirectoryAtomically(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function replaceDirectoryAtomically(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const backup = `${destination}.${randomUUID()}.backup`;
  await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
  await rename(destination, backup);
  try {
    await rename(temporary, destination);
    await rm(backup, { recursive: true });
  } catch (error) {
    if (await exists(destination)) await rm(destination, { recursive: true, force: true });
    await rename(backup, destination);
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function isOwnedDirectory(path: string): Promise<boolean> {
  const details = await lstat(path);
  return details.isDirectory() && !details.isSymbolicLink();
}

async function assertSafeSkillParents(root: string, destination: string): Promise<void> {
  const parts = relative(root, destination).split(sep).slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if ((await exists(current)) && (await lstat(current)).isSymbolicLink()) {
      throw new PoiesisError("SKILL_PATH_UNSAFE", "Refusing to traverse a symlinked skill parent", {
        path: relative(root, current),
      });
    }
  }
}

async function containsSymlink(directory: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && (await containsSymlink(join(directory, entry.name)))) return true;
  }
  return false;
}

export async function hashOwnedSkillDirectory(path: string): Promise<string> {
  if (!(await isOwnedDirectory(path)) || (await containsSymlink(path))) {
    throw new PoiesisError("SKILL_PATH_UNSAFE", "An owned skill must be a real directory without symlinks", { path });
  }
  return hashDirectory(path);
}

function manifestSkill(defaultSkill: DefaultSkill, root: string, hash: string, preexisting: boolean): ManagedSkill {
  return {
    source: defaultSkill.source,
    name: defaultSkill.name,
    path: relative(root, skillPath(root, defaultSkill.name)),
    preexisting,
    installedRevision: preexisting ? "preexisting" : defaultSkill.revision,
    hash,
  };
}

export async function installDefaultSkills(
  root: string,
  previous: ManagedSkill[] = [],
  options: SkillMaintenanceOptions = {},
): Promise<ManagedSkill[]> {
  const defaults = await loadDefaultSkills();
  const previousByName = new Map(previous.map((skill) => [skill.name, skill]));
  const toInstall: DefaultSkill[] = [];

  for (const skill of defaults) {
    const destination = skillPath(root, skill.name);
    await assertSafeSkillParents(root, destination);
    const prior = previousByName.get(skill.name);
    if (prior?.preexisting) continue;

    if (prior !== undefined) {
      if (prior.source !== skill.source || prior.path !== relative(root, destination) || prior.hash === undefined) {
        throw new PoiesisError("SKILL_OWNERSHIP_INVALID", "Managed skill provenance is incomplete or changed", {
          name: skill.name,
        });
      }
      if (!(await exists(destination)) || !(await isOwnedDirectory(destination))) {
        throw new PoiesisError("SKILL_OWNERSHIP_LOST", "Managed skill directory is missing or not a directory", {
          path: prior.path,
        });
      }
      const currentHash = await hashOwnedSkillDirectory(destination);
      if (currentHash !== prior.hash) {
        throw new PoiesisError("SKILL_OWNERSHIP_LOST", "Refusing to replace a modified managed skill", {
          path: prior.path,
          expected: prior.hash,
          actual: currentHash,
        });
      }
      if (options.replaceOwned && prior.installedRevision !== skill.revision) toInstall.push(skill);
      continue;
    }

    if (!(await exists(destination))) toInstall.push(skill);
    else if ((await pathKind(destination)) !== "directory") {
      throw new PoiesisError("SKILL_PATH_CONFLICT", "A default skill path exists and is not a directory", {
        path: relative(root, destination),
      });
    }
  }

  const staged = toInstall.length > 0 ? await stageSkills(toInstall) : undefined;
  const changed: Array<{ skill: DefaultSkill; previous?: string; installedHash: string }> = [];
  try {
    if (staged !== undefined) {
      for (const skill of toInstall) {
        const destination = skillPath(root, skill.name);
        const source = skillPath(staged.root, skill.name);
        const prior = previousByName.get(skill.name);
        const installedHash = await hashOwnedSkillDirectory(source);
        if (prior !== undefined && !prior.preexisting) {
          const backup = join(staged.root, ".poiesis-backups", skill.name);
          await mkdir(dirname(backup), { recursive: true });
          await cp(destination, backup, { recursive: true, errorOnExist: true, force: false });
          await replaceDirectoryAtomically(source, destination);
          changed.push({ skill, previous: backup, installedHash });
        } else {
          await installDirectoryAtomically(source, destination);
          changed.push({ skill, installedHash });
        }
      }
    }

    const managed: ManagedSkill[] = [];
    for (const skill of defaults) {
      const destination = skillPath(root, skill.name);
      const prior = previousByName.get(skill.name);
      if (!(await exists(destination)) || (await pathKind(destination)) !== "directory") {
        throw new PoiesisError("SKILL_MISSING", "A default skill is unavailable after installation", {
          path: relative(root, destination),
        });
      }
      const preexisting = prior?.preexisting ?? !toInstall.some((candidate) => candidate.name === skill.name);
      const hash = preexisting ? await hashDirectory(destination) : await hashOwnedSkillDirectory(destination);
      managed.push(manifestSkill(skill, root, hash, preexisting));
    }

    const defaultNames = new Set(defaults.map((skill) => skill.name));
    managed.push(...previous.filter((skill) => !defaultNames.has(skill.name)));
    return managed;
  } catch (error) {
    for (const change of [...changed].reverse()) {
      const destination = skillPath(root, change.skill.name);
      if (!(await exists(destination)) || !(await isOwnedDirectory(destination))) continue;
      try {
        if ((await hashOwnedSkillDirectory(destination)) !== change.installedHash) continue;
      } catch {
        continue;
      }
      if (change.previous === undefined) await rm(destination, { recursive: true });
      else await replaceDirectoryAtomically(change.previous, destination);
    }
    throw error;
  } finally {
    await staged?.cleanup();
  }
}

export async function removeOwnedSkills(root: string, skills: ManagedSkill[]): Promise<SkillRemovalResult> {
  const result: SkillRemovalResult = { removed: [], preserved: [] };
  for (const skill of skills) {
    if (skill.preexisting) continue;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skill.name)) {
      result.preserved.push({ path: skill.path, reason: "invalid skill name" });
      continue;
    }
    const expectedPath = relative(root, skillPath(root, skill.name));
    if (skill.path !== expectedPath || skill.hash === undefined) {
      result.preserved.push({ path: skill.path, reason: "invalid ownership provenance" });
      continue;
    }
    const destination = join(root, skill.path);
    try {
      await assertSafeSkillParents(root, destination);
    } catch {
      result.preserved.push({ path: skill.path, reason: "skill parent is symlinked" });
      continue;
    }
    if (!(await exists(destination))) {
      result.removed.push(skill.path);
      continue;
    }
    if (!(await isOwnedDirectory(destination))) {
      result.preserved.push({ path: skill.path, reason: "path is not a directory" });
      continue;
    }
    let currentHash: string;
    try {
      currentHash = await hashOwnedSkillDirectory(destination);
    } catch {
      result.preserved.push({ path: skill.path, reason: "directory contains a symlink or unsafe node" });
      continue;
    }
    if (currentHash !== skill.hash) {
      result.preserved.push({ path: skill.path, reason: "directory hash changed" });
      continue;
    }
    await rm(destination, { recursive: true });
    result.removed.push(skill.path);
  }
  return result;
}

export async function installCapability(root: string, input: CapabilityInstallInput): Promise<ManagedSkill> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.source)) {
    throw new PoiesisError("INVALID_SKILL_SOURCE", "Capability source must use owner/repository form", {
      source: input.source,
    });
  }
  if (!/^[a-f0-9]{40}$/.test(input.revision)) {
    throw new PoiesisError("UNPINNED_CAPABILITY", "Capability installation requires an exact 40-character revision", {
      revision: input.revision,
    });
  }
  const destination = skillPath(root, input.name);
  await assertSafeSkillParents(root, destination);
  const manifest = await loadManifest(root);
  const prior = manifest.skills.find((skill) => skill.name === input.name);

  if (prior?.preexisting) return prior;
  if (prior !== undefined) {
    if (prior.source !== input.source || prior.path !== relative(root, destination) || prior.hash === undefined) {
      throw new PoiesisError("SKILL_OWNERSHIP_INVALID", "Capability ownership provenance does not match", {
        name: input.name,
      });
    }
    const actual = await hashOwnedSkillDirectory(destination);
    if (actual !== prior.hash) {
      throw new PoiesisError("SKILL_OWNERSHIP_LOST", "Refusing to replace a modified capability", {
        path: prior.path,
        expected: prior.hash,
        actual,
      });
    }
    if (prior.installedRevision === input.revision) return prior;
  } else if (await exists(destination)) {
    if ((await pathKind(destination)) !== "directory") {
      throw new PoiesisError("SKILL_PATH_CONFLICT", "Capability destination is not a directory", {
        path: relative(root, destination),
      });
    }
    const preexisting: ManagedSkill = {
      source: input.source,
      name: input.name,
      path: relative(root, destination),
      preexisting: true,
      installedRevision: "preexisting",
      hash: await hashDirectory(destination),
    };
    const next = { ...manifest, skills: [...manifest.skills, preexisting] };
    await atomicWrite(poiesisPath(root, "manifest.json"), serializeManifest(next));
    return preexisting;
  }

  const selected: DefaultSkill = input;
  const staged = await stageSkills([selected]);
  const source = skillPath(staged.root, input.name);
  const backup = join(staged.root, ".poiesis-backup", input.name);
  let changed = false;
  try {
    if (prior === undefined) {
      await installDirectoryAtomically(source, destination);
    } else {
      await mkdir(dirname(backup), { recursive: true });
      await cp(destination, backup, { recursive: true, errorOnExist: true, force: false });
      await replaceDirectoryAtomically(source, destination);
    }
    changed = true;
    const installed: ManagedSkill = {
      source: input.source,
      name: input.name,
      path: relative(root, destination),
      preexisting: false,
      installedRevision: input.revision,
      hash: await hashOwnedSkillDirectory(destination),
    };
    const nextSkills = prior === undefined
      ? [...manifest.skills, installed]
      : manifest.skills.map((skill) => (skill.name === input.name ? installed : skill));
    await atomicWrite(poiesisPath(root, "manifest.json"), serializeManifest({ ...manifest, skills: nextSkills }));
    return installed;
  } catch (error) {
    if (changed && (await exists(destination))) {
      await rm(destination, { recursive: true, force: true });
      if (prior !== undefined && (await exists(backup))) await rename(backup, destination);
    }
    throw error;
  } finally {
    await staged.cleanup();
  }
}

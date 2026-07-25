// ---------------------------------------------------------------------------
// Skills management — Install / Remove / Update / List / Search
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { cloneRepoShallow, normalizeGitUrl } from "./git-ops.js";
import { copyDirectoryWithoutLinks, requireRealDirectoryTree } from "./fs-safe.js";
import {
  addSkillToManifest,
  ensureSkillsDir,
  getSkillsDir,
  readManifest,
  removeSkillFromManifest,
  writeManifest,
} from "./manifest.js";
import { readPrivateTextFile } from "./fs-safe.js";
import { parseSkillMdContent, scanForSkills } from "./scanner.js";
import type { DiscoveredSkill, InstalledSkillMeta, SkillDetail } from "./types.js";

/** Sanitize a skill name for use as a directory name */
function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!sanitized) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return sanitized;
}

/** Create a unique temp directory for cloning */
function createTempDir(): string {
  const base = path.join(os.tmpdir(), "skills-clone");
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }
  return fs.mkdtempSync(path.join(base, "repo-"));
}

/** Remove a directory recursively (safe) */
function removeDirSafe(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clone a repo and scan for available skills.
 * Returns discovered skills and the temp directory path (caller must clean up).
 */
export async function discoverSkillsFromRepo(repoUrl: string): Promise<{
  readonly skills: ReadonlyArray<DiscoveredSkill>;
  readonly tempDir: string;
  readonly commitHash: string;
}> {
  const tempDir = createTempDir();
  try {
    const commitHash = await cloneRepoShallow(repoUrl, tempDir);
    const skills = await scanForSkills(tempDir);
    return { skills, tempDir, commitHash };
  } catch (error) {
    removeDirSafe(tempDir);
    throw error;
  }
}

/**
 * Install a single skill from a repo URL.
 * If skillName is provided, installs only that skill.
 * Otherwise, throws an error (use discoverSkillsFromRepo + installSkillsFromClone).
 */
export async function installSkill(
  repoUrl: string,
  skillName: string,
): Promise<InstalledSkillMeta> {
  const results = await installSkillsFromRepo(repoUrl, [skillName]);
  if (results.length === 0) {
    throw new Error(`Skill "${skillName}" not found in repository`);
  }
  return results[0];
}

/**
 * Install multiple skills from the same repo (shares a single clone).
 */
export async function installSkillsFromRepo(
  repoUrl: string,
  skillNames: ReadonlyArray<string>,
): Promise<ReadonlyArray<InstalledSkillMeta>> {
  const { skills, tempDir, commitHash } = await discoverSkillsFromRepo(repoUrl);

  try {
    return installSkillsFromClone(repoUrl, skills, skillNames, tempDir, commitHash);
  } finally {
    removeDirSafe(tempDir);
  }
}

/**
 * Install skills from an already-cloned repo.
 * Used when the caller has already done discoverSkillsFromRepo (e.g., interactive mode).
 */
export function installSkillsFromClone(
  repoUrl: string,
  discoveredSkills: ReadonlyArray<DiscoveredSkill>,
  skillNames: ReadonlyArray<string>,
  cloneDir: string,
  commitHash: string,
): ReadonlyArray<InstalledSkillMeta> {
  const normalizedRepoUrl = normalizeGitUrl(repoUrl);
  ensureSkillsDir();
  const skillsDir = getSkillsDir();
  let manifest = readManifest();
  const installed: InstalledSkillMeta[] = [];

  for (const name of skillNames) {
    const discovered = discoveredSkills.find(
      (s) => s.name === name || s.relativePath.endsWith(name),
    );

    if (!discovered) {
      throw new Error(
        `Skill "${name}" not found. Available skills: ${discoveredSkills.map((s) => s.name).join(", ")}`,
      );
    }

    const safeName = sanitizeName(discovered.name);
    const srcDir = path.join(cloneDir, discovered.relativePath);
    const destDir = path.join(skillsDir, safeName);
    requireRealDirectoryTree(cloneDir, srcDir);

    // Remove existing installation if present
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }

    copyDirectoryWithoutLinks(srcDir, destDir);

    const meta: InstalledSkillMeta = {
      name: discovered.name,
      description: discovered.description,
      sourceRepo: normalizedRepoUrl,
      commitHash,
      installedAt: new Date().toISOString(),
      relativePath: discovered.relativePath,
    };

    manifest = addSkillToManifest(manifest, meta);
    installed.push(meta);
  }

  writeManifest(manifest);
  return installed;
}

/** Remove an installed skill by name. */
export function removeSkill(name: string): void {
  const skillsDir = getSkillsDir();
  const manifest = readManifest();
  const meta = manifest.skills[name];

  if (!meta) {
    // Try to find by sanitized name
    const safeName = sanitizeName(name);
    const dir = path.join(skillsDir, safeName);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // Also try removing from manifest by original name
    const updatedManifest = removeSkillFromManifest(manifest, name);
    writeManifest(updatedManifest);
    return;
  }

  const safeName = sanitizeName(meta.name);
  const dir = path.join(skillsDir, safeName);

  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const updatedManifest = removeSkillFromManifest(manifest, name);
  writeManifest(updatedManifest);
}

/**
 * Update an installed skill by re-cloning from its source repo.
 * Returns the updated metadata.
 */
export async function updateSkill(name: string): Promise<InstalledSkillMeta> {
  const manifest = readManifest();
  const meta = manifest.skills[name];

  if (!meta) {
    throw new Error(`Skill "${name}" is not installed`);
  }

  // Re-install from the same source repo
  const result = await installSkill(meta.sourceRepo, name);
  return result;
}

/**
 * Update all installed skills.
 * Returns array of updated skills and any errors.
 */
export async function updateAllSkills(): Promise<{
  readonly updated: ReadonlyArray<InstalledSkillMeta>;
  readonly errors: ReadonlyArray<{ name: string; error: string }>;
}> {
  const manifest = readManifest();
  const entries = Object.values(manifest.skills);
  const updated: InstalledSkillMeta[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const meta of entries) {
    try {
      const result = await updateSkill(meta.name);
      updated.push(result);
    } catch (error) {
      errors.push({
        name: meta.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { updated, errors };
}

/** List all installed skills from the manifest. */
export function listInstalledSkills(): ReadonlyArray<InstalledSkillMeta> {
  const manifest = readManifest();
  return Object.values(manifest.skills);
}

/** Get detailed info about an installed skill. */
export function getSkillInfo(name: string): SkillDetail | null {
  const manifest = readManifest();
  const meta = manifest.skills[name];

  if (!meta) return null;

  const safeName = sanitizeName(meta.name);
  const skillMdPath = path.join(getSkillsDir(), safeName, "SKILL.md");
  const raw = readPrivateTextFile(getSkillsDir(), skillMdPath);
  if (raw === null) {
    return { meta, content: "(SKILL.md not found)" };
  }

  const { content } = parseSkillMdContent(raw, skillMdPath);
  return { meta, content };
}

/** Search installed skills by name or description. */
export function searchSkills(query: string): ReadonlyArray<InstalledSkillMeta> {
  const lowerQuery = query.toLowerCase();
  const manifest = readManifest();

  return Object.values(manifest.skills).filter(
    (skill) =>
      skill.name.toLowerCase().includes(lowerQuery) ||
      skill.description.toLowerCase().includes(lowerQuery),
  );
}

/** Clean up any leftover temp directories. */
export function cleanupTempDirs(): void {
  const base = path.join(os.tmpdir(), "skills-clone");
  removeDirSafe(base);
}

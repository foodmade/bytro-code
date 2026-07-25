// ---------------------------------------------------------------------------
// Skills management — Manifest file CRUD
// ---------------------------------------------------------------------------

import * as path from "node:path";
import * as os from "node:os";
import {
  ensurePrivateDirectory,
  readPrivateTextFile,
  writePrivateTextFileAtomic,
} from "./fs-safe.js";
import type { InstalledSkillMeta, SkillsManifest } from "./types.js";

const MANIFEST_FILENAME = ".skills-manifest.json";

/** Returns the global skills directory: ~/.bytro-community/skills. */
export function getSkillsDir(): string {
  return path.join(os.homedir(), ".bytro-community", "skills");
}

/** Returns the manifest path under the isolated Community Edition home. */
export function getManifestPath(): string {
  return path.join(getSkillsDir(), MANIFEST_FILENAME);
}

/** Ensure only the isolated Community Edition skills directory exists. */
export function ensureSkillsDir(): void {
  const dir = getSkillsDir();
  ensurePrivateDirectory(path.dirname(dir));
  ensurePrivateDirectory(dir);
}

/** Read the manifest file. Returns an empty manifest if not found. */
export function readManifest(): SkillsManifest {
  ensureSkillsDir();
  const manifestPath = getManifestPath();
  try {
    const raw = readPrivateTextFile(getSkillsDir(), manifestPath);
    if (raw === null) return { version: 1, skills: {} };
    const parsed = JSON.parse(raw) as SkillsManifest;
    return {
      version: parsed.version ?? 1,
      skills: parsed.skills ?? {},
    };
  } catch {
    return { version: 1, skills: {} };
  }
}

/** Write the manifest file atomically (write to temp, then rename). */
export function writeManifest(manifest: SkillsManifest): void {
  ensureSkillsDir();
  const manifestPath = getManifestPath();
  writePrivateTextFileAtomic(getSkillsDir(), manifestPath, JSON.stringify(manifest, null, 2));
}

/** Add a skill to the manifest (immutable). */
export function addSkillToManifest(
  manifest: SkillsManifest,
  meta: InstalledSkillMeta,
): SkillsManifest {
  return {
    ...manifest,
    skills: {
      ...manifest.skills,
      [meta.name]: meta,
    },
  };
}

/** Remove a skill from the manifest (immutable). */
export function removeSkillFromManifest(manifest: SkillsManifest, name: string): SkillsManifest {
  const { [name]: _removed, ...remaining } = manifest.skills;
  return {
    ...manifest,
    skills: remaining,
  };
}

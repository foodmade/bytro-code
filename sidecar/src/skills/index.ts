// ---------------------------------------------------------------------------
// Skills management — Public API re-exports
// ---------------------------------------------------------------------------

export type {
  SkillFrontmatter,
  DiscoveredSkill,
  InstalledSkillMeta,
  SkillsManifest,
  SkillDetail,
} from "./types.js";

export {
  getSkillsDir,
  getManifestPath,
  ensureSkillsDir,
  readManifest,
  writeManifest,
} from "./manifest.js";

export { normalizeGitUrl, cloneRepoShallow, getRepoHeadHash } from "./git-ops.js";

export { parseSkillMd, scanForSkills } from "./scanner.js";

export {
  discoverSkillsFromRepo,
  installSkill,
  installSkillsFromRepo,
  installSkillsFromClone,
  removeSkill,
  updateSkill,
  updateAllSkills,
  listInstalledSkills,
  getSkillInfo,
  searchSkills,
  cleanupTempDirs,
} from "./installer.js";

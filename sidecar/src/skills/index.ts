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
  discoverSkillsFromRepo,
  installSkill,
  installSkillsFromClone,
  removeSkill,
  updateSkill,
  updateAllSkills,
  listInstalledSkills,
  getSkillInfo,
  searchSkills,
  cleanupTempDirs,
} from "./installer.js";

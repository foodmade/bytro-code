// ---------------------------------------------------------------------------
// Skills management — Type definitions
// ---------------------------------------------------------------------------

/** SKILL.md YAML frontmatter structure */
export interface SkillFrontmatter {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly author?: string;
  readonly license?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly agent?: string;
  readonly compatibility?: string;
  readonly "allowed-tools"?: ReadonlyArray<string>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A skill discovered in a repository (before installation) */
export interface DiscoveredSkill {
  readonly name: string;
  readonly description: string;
  readonly relativePath: string;
  readonly frontmatter: SkillFrontmatter;
}

/** Metadata for an installed skill */
export interface InstalledSkillMeta {
  readonly name: string;
  readonly description: string;
  readonly sourceRepo: string;
  readonly commitHash: string;
  readonly installedAt: string;
  readonly relativePath: string;
}

/** Manifest stored at ~/.bytro-community/skills/<provider>/.skills-manifest.json. */
export interface SkillsManifest {
  readonly version: 1;
  readonly skills: Readonly<Record<string, InstalledSkillMeta>>;
}

/** Detailed info combining metadata + SKILL.md content */
export interface SkillDetail {
  readonly meta: InstalledSkillMeta;
  readonly content: string;
}

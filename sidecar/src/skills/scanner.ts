// ---------------------------------------------------------------------------
// Skills management — SKILL.md scanner and parser
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import type { DiscoveredSkill, SkillFrontmatter } from "./types.js";

const SKILL_FILENAME = "SKILL.md";

/** Directories to skip when scanning for SKILL.md files */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "__pycache__",
  ".next",
  ".venv",
  "venv",
]);

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Extracts the content between the opening and closing `---` delimiters.
 * Uses a lightweight parser to avoid external dependencies.
 */
export function parseSkillMd(filePath: string): {
  frontmatter: SkillFrontmatter;
  content: string;
} {
  const raw = fs.readFileSync(filePath, "utf-8");
  return parseSkillMdContent(raw, filePath);
}

/** Parse already-read SKILL.md content without opening the file again. */
export function parseSkillMdContent(
  raw: string,
  filePath: string,
): {
  frontmatter: SkillFrontmatter;
  content: string;
} {
  const lines = raw.split("\n");

  // Find frontmatter boundaries
  if (lines[0]?.trim() !== "---") {
    // No frontmatter — use directory name as skill name
    const dirName = path.basename(path.dirname(filePath));
    return {
      frontmatter: { name: dirName },
      content: raw,
    };
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    const dirName = path.basename(path.dirname(filePath));
    return {
      frontmatter: { name: dirName },
      content: raw,
    };
  }

  const yamlLines = lines.slice(1, closingIndex);
  const frontmatter = parseSimpleYaml(yamlLines);
  const content = lines.slice(closingIndex + 1).join("\n").trim();

  // Ensure name exists, fallback to directory name
  if (!frontmatter["name"]) {
    frontmatter["name"] = path.basename(path.dirname(filePath));
  }

  return { frontmatter: frontmatter as unknown as SkillFrontmatter, content };
}

/**
 * Lightweight YAML parser for SKILL.md frontmatter.
 * Handles simple key: value pairs, lists, and nested metadata.
 * Does NOT handle full YAML spec — only the subset used by skills.
 */
function parseSimpleYaml(
  lines: ReadonlyArray<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of lines) {
    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    // List item under current key
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey && currentList) {
      currentList.push(listMatch[1].trim());
      result[currentKey] = currentList;
      continue;
    }

    // Key: value pair
    const kvMatch = line.match(/^(\S[^:]*?):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();

      if (value === "") {
        // Could be start of a list or nested object
        currentKey = key;
        currentList = [];
        result[key] = currentList;
      } else {
        // Remove quotes if present
        const unquoted = value.replace(/^["'](.*)["']$/, "$1");
        result[key] = unquoted;
        currentKey = key;
        currentList = null;
      }
    }
  }

  return result;
}

/**
 * Recursively scan a directory for SKILL.md files.
 * Returns an array of discovered skills with their parsed frontmatter.
 */
export async function scanForSkills(
  rootDir: string,
): Promise<ReadonlyArray<DiscoveredSkill>> {
  const skills: DiscoveredSkill[] = [];
  walkDirectory(rootDir, rootDir, skills);
  return skills;
}

function walkDirectory(
  currentDir: string,
  rootDir: string,
  results: DiscoveredSkill[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walkDirectory(path.join(currentDir, entry.name), rootDir, results);
    } else if (entry.name === SKILL_FILENAME) {
      const fullPath = path.join(currentDir, entry.name);
      try {
        const { frontmatter } = parseSkillMd(fullPath);
        const relativePath = path.relative(rootDir, currentDir);
        results.push({
          name: frontmatter.name,
          description: (frontmatter.description as string) ?? "",
          relativePath,
          frontmatter,
        });
      } catch {
        // Skip unparseable SKILL.md files
      }
    }
  }
}

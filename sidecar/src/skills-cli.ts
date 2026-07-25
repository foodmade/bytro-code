#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Skills CLI — Command-line interface for managing Claude Code skills
// ---------------------------------------------------------------------------
// Usage:
//   npx skills add <url> [--skill <name>]
//   npx skills remove <name>
//   npx skills list
//   npx skills update [name]
//   npx skills search <query>
//   npx skills info <name>
// ---------------------------------------------------------------------------

import { parseArgs } from "node:util";
import {
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
} from "./skills/index.js";
import { normalizeGitUrl } from "./skills/git-ops.js";
import type { DiscoveredSkill } from "./skills/index.js";

// ---------------------------------------------------------------------------
// ANSI colors (no dependency needed)
// ---------------------------------------------------------------------------
const isColorSupported =
  process.stdout.isTTY && process.env["NO_COLOR"] === undefined;

const c = {
  bold: (s: string) => (isColorSupported ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (isColorSupported ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (isColorSupported ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (isColorSupported ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (isColorSupported ? `\x1b[36m${s}\x1b[0m` : s),
  dim: (s: string) => (isColorSupported ? `\x1b[2m${s}\x1b[0m` : s),
};

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------
function printHelp(): void {
  console.log(`
${c.bold("skills")} — Claude Code Skills Manager

${c.bold("USAGE")}
  skills <command> [options]

${c.bold("COMMANDS")}
  ${c.cyan("add")} <url> [--skill <name>]   Install skill(s) from a GitHub repository
  ${c.cyan("remove")} <name>                 Remove an installed skill
  ${c.cyan("list")}                           List all installed skills
  ${c.cyan("update")} [name]                 Update a skill (or all if no name given)
  ${c.cyan("search")} <query>                Search installed skills
  ${c.cyan("info")} <name>                   Show detailed skill information

${c.bold("EXAMPLES")}
  skills add https://github.com/anthropics/skills --skill find-skills
  skills add anthropics/skills
  skills remove find-skills
  skills list
  skills update find-skills
  skills search code
  skills info find-skills
`);
}

// ---------------------------------------------------------------------------
// Interactive skill selection (lazy-loaded)
// ---------------------------------------------------------------------------
async function selectSkillsInteractively(
  skills: ReadonlyArray<DiscoveredSkill>,
): Promise<ReadonlyArray<string>> {
  // Try to use @inquirer/prompts for interactive selection
  try {
    // Dynamic import with string indirection to bypass tsc module resolution
    const pkgName = ["@inquirer", "prompts"].join("/");
    const mod = await (Function("p", "return import(p)")(pkgName)) as {
      checkbox: (opts: { message: string; choices: ReadonlyArray<{ name: string; value: string; checked: boolean }> }) => Promise<string[]>;
    };
    const selected = await mod.checkbox({
      message: "Select skills to install:",
      choices: skills.map((s) => ({
        name: `${s.name}${s.description ? ` — ${s.description}` : ""}`,
        value: s.name,
        checked: false,
      })),
    });
    return selected;
  } catch {
    // Fallback: if inquirer is not available, install all
    console.log(c.yellow("Interactive selection unavailable. Installing all skills."));
    return skills.map((s) => s.name);
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleAdd(positionals: string[], skillName?: string): Promise<void> {
  const url = positionals[0];
  if (!url) {
    console.error(c.red("Error: Repository URL is required."));
    console.error("Usage: skills add <url> [--skill <name>]");
    process.exit(1);
  }

  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeGitUrl(url);
  } catch (error) {
    console.error(
      c.red(
        `Invalid repository: ${error instanceof Error ? error.message : "URL validation failed."}`,
      ),
    );
    process.exit(1);
  }

  if (skillName) {
    // Direct install
    console.log(
      `Installing skill ${c.cyan(skillName)} from ${c.dim(normalizedUrl)}...`,
    );
    try {
      const meta = await installSkill(normalizedUrl, skillName);
      console.log(c.green(`Successfully installed "${meta.name}"`));
      console.log(`  Source: ${meta.sourceRepo}`);
      console.log(`  Commit: ${meta.commitHash.slice(0, 8)}`);
    } catch (error) {
      console.error(c.red(`Failed to install: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  } else {
    // Interactive mode: clone, scan, select
    console.log(`Scanning repository ${c.dim(normalizedUrl)} for skills...`);
    let result;
    try {
      result = await discoverSkillsFromRepo(normalizedUrl);
    } catch (error) {
      console.error(c.red(`Failed to scan repository: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }

    const { skills, tempDir, commitHash } = result;

    if (skills.length === 0) {
      console.log(c.yellow("No skills found in this repository."));
      cleanupTempDirs();
      return;
    }

    console.log(`Found ${c.bold(String(skills.length))} skill(s):\n`);
    for (const s of skills) {
      console.log(`  ${c.cyan(s.name)}${s.description ? ` — ${s.description}` : ""}`);
    }
    console.log();

    try {
      const selected = await selectSkillsInteractively(skills);

      if (selected.length === 0) {
        console.log("No skills selected.");
        return;
      }

      console.log(`\nInstalling ${selected.length} skill(s)...`);
      const installed = installSkillsFromClone(
        normalizedUrl,
        skills,
        selected,
        tempDir,
        commitHash,
      );

      for (const meta of installed) {
        console.log(c.green(`  Installed "${meta.name}"`));
      }
      console.log(c.green(`\nDone! ${installed.length} skill(s) installed.`));
    } finally {
      cleanupTempDirs();
    }
  }
}

function handleRemove(positionals: string[]): void {
  const name = positionals[0];
  if (!name) {
    console.error(c.red("Error: Skill name is required."));
    console.error("Usage: skills remove <name>");
    process.exit(1);
  }

  try {
    removeSkill(name);
    console.log(c.green(`Removed skill "${name}"`));
  } catch (error) {
    console.error(c.red(`Failed to remove: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

function handleList(): void {
  const skills = listInstalledSkills();

  if (skills.length === 0) {
    console.log(c.dim("No skills installed."));
    console.log(c.dim("Use 'skills add <url>' to install skills."));
    return;
  }

  console.log(c.bold(`Installed skills (${skills.length}):\n`));

  const maxNameLen = Math.max(...skills.map((s) => s.name.length));

  for (const s of skills) {
    const name = s.name.padEnd(maxNameLen + 2);
    const desc = s.description || c.dim("(no description)");
    const date = new Date(s.installedAt).toLocaleDateString();
    console.log(`  ${c.cyan(name)} ${desc} ${c.dim(`[${date}]`)}`);
  }
}

async function handleUpdate(positionals: string[]): Promise<void> {
  const name = positionals[0];

  if (name) {
    console.log(`Updating skill ${c.cyan(name)}...`);
    try {
      const meta = await updateSkill(name);
      console.log(c.green(`Updated "${meta.name}" to ${meta.commitHash.slice(0, 8)}`));
    } catch (error) {
      console.error(c.red(`Failed to update: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  } else {
    console.log("Updating all installed skills...\n");
    const { updated, errors } = await updateAllSkills();

    for (const meta of updated) {
      console.log(c.green(`  Updated "${meta.name}"`));
    }
    for (const err of errors) {
      console.log(c.red(`  Failed "${err.name}": ${err.error}`));
    }

    console.log(`\n${c.bold(`${updated.length} updated, ${errors.length} failed`)}`);
  }
}

function handleSearch(positionals: string[]): void {
  const query = positionals[0];
  if (!query) {
    console.error(c.red("Error: Search query is required."));
    console.error("Usage: skills search <query>");
    process.exit(1);
  }

  const results = searchSkills(query);

  if (results.length === 0) {
    console.log(c.dim(`No skills matching "${query}"`));
    return;
  }

  console.log(c.bold(`Found ${results.length} skill(s):\n`));
  for (const s of results) {
    console.log(`  ${c.cyan(s.name)} — ${s.description || c.dim("(no description)")}`);
  }
}

function handleInfo(positionals: string[]): void {
  const name = positionals[0];
  if (!name) {
    console.error(c.red("Error: Skill name is required."));
    console.error("Usage: skills info <name>");
    process.exit(1);
  }

  const detail = getSkillInfo(name);

  if (!detail) {
    console.error(c.red(`Skill "${name}" is not installed.`));
    process.exit(1);
  }

  const { meta, content } = detail;

  console.log(c.bold(`\n${meta.name}\n`));
  console.log(`  Description:  ${meta.description || "(none)"}`);
  console.log(`  Source:        ${meta.sourceRepo}`);
  console.log(`  Commit:        ${meta.commitHash.slice(0, 8)}`);
  console.log(`  Installed:     ${new Date(meta.installedAt).toLocaleString()}`);
  console.log(`  Path in repo:  ${meta.relativePath}`);
  console.log(`\n${c.dim("--- SKILL.md content ---")}\n`);
  console.log(content);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const command = args[0];
  const rest = args.slice(1);

  // Parse remaining args
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      skill: { type: "string", short: "s" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values["help"]) {
    printHelp();
    process.exit(0);
  }

  switch (command) {
    case "add":
      await handleAdd(positionals, values["skill"] as string | undefined);
      break;
    case "remove":
    case "rm":
      handleRemove(positionals);
      break;
    case "list":
    case "ls":
      handleList();
      break;
    case "update":
    case "up":
      await handleUpdate(positionals);
      break;
    case "search":
      handleSearch(positionals);
      break;
    case "info":
      handleInfo(positionals);
      break;
    default:
      console.error(c.red(`Unknown command: ${command}`));
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(c.red(`Fatal error: ${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
});

import { getBuiltinSlashCommandDescription } from "@/lib/slash-command-builtins";

// ---------------------------------------------------------------------------
// Static description map for well-known Claude Code slash commands.
// SDK-native commands arrive as name-only strings — this map provides
// fallback descriptions when filesystem .md files don't exist for a command.
// ---------------------------------------------------------------------------

/**
 * Descriptions for well-known Claude Code slash commands.
 * Used as a fallback to enrich SDK-reported commands that lack descriptions.
 */
const KNOWN_COMMAND_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  ["help", "Show help and available commands"],
  ["clear", "Clear conversation history"],
  ["compact", "Compact and summarize conversation context"],
  ["config", "Open or modify Claude Code configuration"],
  ["cost", "Show token usage and cost for this session"],
  ["doctor", "Check Claude Code installation health"],
  ["init", "Initialize project with CLAUDE.md guide"],
  ["login", "Log in to your Anthropic account"],
  ["logout", "Log out of your Anthropic account"],
  ["memory", "Edit Claude's project memory (CLAUDE.md)"],
  ["model", "Switch the active AI model"],
  ["permissions", "View and manage tool permissions"],
  ["review", "Review a pull request or diff"],
  ["status", "Show current session status"],
  ["terminal-setup", "Set up terminal integration"],
  ["vim", "Toggle vim keybinding mode"],
  ["fast", "Toggle fast output mode"],
  ["commit", "Create a git commit with AI-generated message"],
  ["review-pr", "Review a GitHub pull request"],
  ["pr-comments", "View and respond to PR comments"],
  ["find-skills", "Discover and install agent skills"],
]);

/**
 * Look up a description for a known slash command.
 * Returns empty string if the command is not in the known map.
 */
export function getKnownDescription(name: string): string {
  return KNOWN_COMMAND_DESCRIPTIONS.get(name) ?? getBuiltinSlashCommandDescription(name);
}

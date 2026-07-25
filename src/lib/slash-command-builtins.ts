import type { SlashCommandInfo } from "@/stores/chat-types";

export type BuiltinSlashCommandPlatform = "claude" | "codex";

// Cold-start fallback ONLY — the authoritative list is the SDK's
// `Query.supportedCommands()` (plumbed into tool-state-store per platform and
// merged over this one). Every entry here MUST be executable in headless/SDK
// mode: commands the CLI rejects with "isn't available in this environment"
// (/status, /model, /doctor, /login, /vim, …) must NOT be listed — they either
// live in the client layer (see client-slash-commands.ts) or are dropped.
// Verified against `claude -p "/<cmd>"` and supportedCommands() on CLI 0.3.198.
const CLAUDE_BUILTIN_COMMANDS: ReadonlyArray<SlashCommandInfo> = Object.freeze([
  { name: "clear", description: "Clear conversation history", source: "builtin" },
  { name: "compact", description: "Compact and summarize conversation context", source: "builtin" },
  { name: "context", description: "Show current context usage", source: "builtin" },
  { name: "init", description: "Initialize project memory", source: "builtin" },
  { name: "review", description: "Review code changes", source: "builtin" },
  { name: "security-review", description: "Security review of pending changes", source: "builtin" },
  { name: "usage", description: "Show token usage and cost for this session", aliases: ["cost"], source: "builtin" },
]);

const CODEX_BUILTIN_COMMANDS: ReadonlyArray<SlashCommandInfo> = Object.freeze([
  { name: "compact", description: "Ask Codex to summarize and compact the useful context", source: "builtin" },
  { name: "diff", description: "Ask Codex to inspect and summarize current code changes", source: "builtin" },
  { name: "init", description: "Ask Codex to initialize or update project instructions", source: "builtin" },
  { name: "plan", description: "Ask Codex to create a plan before editing", source: "builtin" },
  { name: "review", description: "Ask Codex to review current code changes", source: "builtin" },
  { name: "status", description: "Ask Codex to report workspace and task status", source: "builtin" },
]);

const CODEX_BUILTIN_PROMPTS: Readonly<Record<string, string>> = Object.freeze({
  compact: [
    "Summarize the conversation and current task state into a compact handoff.",
    "Preserve decisions, constraints, open TODOs, relevant files, and next steps.",
    "Do not make code changes unless the user explicitly asks for them in the arguments.",
  ].join("\n"),
  diff: [
    "Inspect the current workspace changes and summarize the diff.",
    "Use git status and git diff where appropriate. Highlight changed files, intent, and risks.",
  ].join("\n"),
  init: [
    "Inspect this project and create or update the appropriate agent instruction file if useful.",
    "Keep instructions concise, project-specific, and consistent with existing conventions.",
  ].join("\n"),
  plan: [
    "Create a concrete implementation plan for the requested task before editing files.",
    "If no task arguments are provided, infer the plan from the current conversation context.",
  ].join("\n"),
  review: [
    "Review the current code changes for correctness, regressions, security issues, and missing tests.",
    "Prioritize actionable findings with file paths and concise rationale.",
  ].join("\n"),
  status: [
    "Report the current workspace and task status.",
    "Include git status when available, active assumptions, and suggested next steps.",
  ].join("\n"),
});

export function expandBuiltinSlashCommandPrompt(
  platform: BuiltinSlashCommandPlatform | null | undefined,
  name: string,
  args: string,
): string | null {
  if (platform !== "codex") return null;
  const prompt = CODEX_BUILTIN_PROMPTS[name];
  if (!prompt) return null;
  const trimmedArgs = args.trim();
  return [
    `<slash-command name="/${name}">`,
    "<command-instructions>",
    prompt,
    "</command-instructions>",
    trimmedArgs ? `<arguments>\n${trimmedArgs}\n</arguments>` : "",
    "Execute the slash command task described above. Do not treat the slash command token as literal user prose.",
    "</slash-command>",
  ].filter(Boolean).join("\n");
}

export function getBuiltinSlashCommands(
  platform: BuiltinSlashCommandPlatform | null | undefined,
): ReadonlyArray<SlashCommandInfo> {
  if (platform === "claude") return CLAUDE_BUILTIN_COMMANDS;
  if (platform === "codex") return CODEX_BUILTIN_COMMANDS;
  return [];
}

export function getBuiltinSlashCommandDescription(name: string): string {
  for (const command of [...CLAUDE_BUILTIN_COMMANDS, ...CODEX_BUILTIN_COMMANDS]) {
    if (command.name === name) return command.description;
  }
  return "";
}

export function mergeSlashCommands(
  base: ReadonlyArray<SlashCommandInfo>,
  overrides: ReadonlyArray<SlashCommandInfo>,
): ReadonlyArray<SlashCommandInfo> {
  const merged = new Map<string, SlashCommandInfo>();
  for (const command of base) {
    merged.set(command.name, command);
  }
  for (const command of overrides) {
    const previous = merged.get(command.name);
    merged.set(command.name, {
      name: command.name,
      description: command.description.trim() || previous?.description || "",
      argumentHint: command.argumentHint ?? previous?.argumentHint,
      aliases: command.aliases ?? previous?.aliases,
      source: command.source ?? previous?.source,
    });
  }
  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

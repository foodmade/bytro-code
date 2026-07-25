// ---------------------------------------------------------------------------
// Agent name resolution — maps Task descriptions and agent types back to
// configured team member names.
// ---------------------------------------------------------------------------

import type { TeamsAgentConfig } from "./protocol.js";

/**
 * Extract a human-readable summary from a Task tool result.
 * The result is often raw text from the subagent output. We attempt to
 * extract only the final conclusion / summary paragraph, stripping any
 * raw JSON or overly verbose SDK output.
 */
export function extractTaskResultSummary(resultText: string): string {
  if (!resultText || resultText.length < 5) return "";

  // If the result looks like a JSON blob, try to extract meaningful text from it
  const trimmed = resultText.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.result === "string") return parsed.result.slice(0, 200);
      if (typeof parsed.content === "string") return parsed.content.slice(0, 200);
      if (typeof parsed.message === "string") return parsed.message.slice(0, 200);
      return "";
    } catch {
      // Not valid JSON — it's probably just text that starts with { or [
    }
  }

  // For plain text: if it's very long, take the last meaningful paragraph
  if (trimmed.length > 500) {
    const paragraphs = trimmed.split(/\n\n+/).filter((p) => p.trim().length > 10);
    if (paragraphs.length > 0) {
      const lastParagraph = paragraphs[paragraphs.length - 1].trim();
      return lastParagraph.slice(0, 300);
    }
    return trimmed.slice(trimmed.length - 300);
  }

  return trimmed;
}

/** Escape special regex characters in a string so it can be used in `new RegExp()`. */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Test whether `name` appears as a whole word in `text` (case-insensitive). */
function matchesWholeWord(text: string, name: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i");
  return pattern.test(text);
}

/** Try to map a Task description or agent_type back to a configured agent name. */
export function resolveAgentName(
  description: string | undefined,
  agentType: string,
  agents: ReadonlyArray<TeamsAgentConfig>,
): string | undefined {
  // Highest priority: explicit [AGENT_NAME:...] prefix
  if (description) {
    const nameMatch = description.match(/^\[AGENT_NAME:(\S+)\]/);
    if (nameMatch) {
      const explicitName = nameMatch[1];
      const found = agents.find((a) => a.name === explicitName);
      if (found) return found.name;
      return explicitName;
    }
  }

  // First try: whole-word match on agent name in description.
  if (description) {
    const sorted = [...agents].sort((a, b) => b.name.length - a.name.length);
    for (const agent of sorted) {
      if (matchesWholeWord(description, agent.name)) {
        return agent.name;
      }
    }
  }

  // Second try: match agentType to agent name or role
  for (const agent of agents) {
    if (agent.role === agentType || agent.name === agentType) {
      return agent.name;
    }
  }

  // Third try: fuzzy matching via role-based keywords
  const lowerType = agentType.toLowerCase();

  const roleKeywords: Record<string, string[]> = {
    coder: ["code", "dev", "implement", "write", "develop", "engineer", "programming"],
    reviewer: ["review", "audit", "check", "inspect", "quality"],
    researcher: ["research", "explore", "investigate", "analyze", "search"],
    tester: ["test", "qa", "verify", "validate", "e2e"],
  };

  for (const agent of agents) {
    const keywords = roleKeywords[agent.role];
    if (!keywords) continue;
    for (const kw of keywords) {
      if (
        (description && matchesWholeWord(description, kw)) ||
        matchesWholeWord(lowerType, kw)
      ) {
        return agent.name;
      }
    }
  }

  // Fallback: return agentType only if it looks like a real name
  const genericTypes = new Set([
    "general-purpose", "Bash", "Explore", "Plan",
    "architect", "build-error-resolver", "code-reviewer",
    "doc-updater", "e2e-runner", "planner", "refactor-cleaner",
    "security-reviewer", "tdd-guide",
  ]);
  if (agentType && !genericTypes.has(agentType)) {
    return agentType;
  }
  return undefined;
}

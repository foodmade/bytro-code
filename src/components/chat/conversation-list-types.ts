import type { ConversationSummary } from "@/stores/conversation-store";

// ── Context Menu Types ──────────────────────────────────────────────

export interface ContextMenuState {
  readonly conversationId: string;
  readonly x: number;
  readonly y: number;
}

// ── Date Grouping ───────────────────────────────────────────────────

export interface DateGroup {
  readonly label: string;
  readonly conversations: ReadonlyArray<ConversationSummary>;
}

// ── Agent Helpers ───────────────────────────────────────────────────

const AGENT_COLORS: Record<string, string> = {
  claude: "var(--color-accent-purple)",
  codex: "#10B981",
  gemini: "#4285F4",
  deepseek: "#06B6D4",
  bigmodel: "#3B82F6",
  grok: "#EF4444",
  gpt: "#10B981",
};

export function getAgentColor(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("claude") || lower.includes("opus") || lower.includes("sonnet") || lower.includes("haiku")) {
    return AGENT_COLORS.claude;
  }
  if (lower.includes("deepseek")) return AGENT_COLORS.deepseek;
  if (lower.includes("glm")) return AGENT_COLORS.bigmodel;
  if (lower.includes("gemini")) return AGENT_COLORS.gemini;
  if (lower.includes("codex") || lower.includes("gpt")) return AGENT_COLORS.gpt;
  if (lower.includes("grok")) return AGENT_COLORS.grok;
  return "var(--color-accent-purple)";
}

export function getAgentLabel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("claude") || lower.includes("opus") || lower.includes("sonnet") || lower.includes("haiku")) {
    return "Claude";
  }
  if (lower.includes("deepseek")) return "DeepSeek";
  if (lower.includes("glm")) return "BigModel";
  if (lower.includes("gemini")) return "Gemini";
  if (lower.includes("codex") || lower.includes("gpt")) return "GPT";
  if (lower.includes("grok")) return "Grok";
  return model;
}

import type { ConversationSummary } from "@/stores/conversation-store";

// ── Date Grouping ───────────────────────────────────────────────────

export interface DateGroup {
  readonly label: string;
  readonly conversations: ReadonlyArray<ConversationSummary>;
}

export function groupByDate(
  conversations: ReadonlyArray<ConversationSummary>,
  runningIds?: ReadonlySet<string>,
): ReadonlyArray<DateGroup> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 6 * 86400000;

  const pinned: ConversationSummary[] = [];
  const today: ConversationSummary[] = [];
  const yesterday: ConversationSummary[] = [];
  const lastWeek: ConversationSummary[] = [];
  const older: ConversationSummary[] = [];

  for (const conv of conversations) {
    if (conv.is_pinned) {
      pinned.push(conv);
      continue;
    }
    const ts = new Date(conv.updated_at).getTime();
    if (ts >= todayStart) {
      today.push(conv);
    } else if (ts >= yesterdayStart) {
      yesterday.push(conv);
    } else if (ts >= weekStart) {
      lastWeek.push(conv);
    } else {
      older.push(conv);
    }
  }

  const sortWithRunning = (arr: ConversationSummary[]): ConversationSummary[] => {
    if (!runningIds || runningIds.size === 0) return arr;
    return [...arr].sort((a, b) => {
      const aRunning = runningIds.has(a.id) ? 1 : 0;
      const bRunning = runningIds.has(b.id) ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  };

  const groups: DateGroup[] = [];
  if (pinned.length > 0) groups.push({ label: "pinned", conversations: sortWithRunning(pinned) });
  if (today.length > 0) groups.push({ label: "today", conversations: sortWithRunning(today) });
  if (yesterday.length > 0) groups.push({ label: "yesterday", conversations: sortWithRunning(yesterday) });
  if (lastWeek.length > 0) groups.push({ label: "lastWeek", conversations: sortWithRunning(lastWeek) });
  if (older.length > 0) groups.push({ label: "older", conversations: sortWithRunning(older) });

  return groups;
}

// ── Agent Helpers ───────────────────────────────────────────────────

const AGENT_COLORS: Record<string, string> = {
  claude: "var(--color-accent-purple)",
  codex: "#10B981",
  gemini: "#4285F4",
  deepseek: "#06B6D4",
  bigmodel: "#3B82F6",
  grok: "#EF4444",
  minimax: "#8B5CF6",
  kimi: "#1890FF",
  gpt: "#10B981",
};

export function getAgentColor(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("claude") || lower.includes("opus") || lower.includes("sonnet") || lower.includes("haiku")) {
    return AGENT_COLORS.claude;
  }
  if (lower.includes("deepseek")) return AGENT_COLORS.deepseek;
  if (lower.includes("minimax")) return AGENT_COLORS.minimax;
  if (lower.includes("kimi")) return AGENT_COLORS.kimi;
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
  if (lower.includes("minimax")) return "MiniMax";
  if (lower.includes("kimi")) return "Kimi";
  if (lower.includes("glm")) return "BigModel";
  if (lower.includes("gemini")) return "Gemini";
  if (lower.includes("codex") || lower.includes("gpt")) return "GPT";
  if (lower.includes("grok")) return "Grok";
  return model;
}

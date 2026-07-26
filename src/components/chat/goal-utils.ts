import type { TodoItem, UsageData } from "@/stores/chat-store";
import type { StreamUsageData } from "@/stores/agent-status-store";

export type GoalStatus =
  | "inactive"
  | "active"
  | "completed"
  | "failed"
  | "blocked"
  | "paused";

export interface GoalSnapshot {
  readonly conversationId: string;
  readonly requestId?: string;
  readonly threadId?: string;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly tokenBudget?: number | null;
  readonly tokensUsed?: number | null;
  readonly timeUsedSeconds?: number | null;
  readonly updatedAt: number;
  readonly source: "app-server" | "derived" | "notification";
  readonly error?: string | null;
}

export interface GoalProgressSummary {
  readonly total: number;
  readonly completed: number;
  readonly running: number;
  readonly blocked: number;
  readonly pending: number;
  readonly percentage: number | null;
  readonly mode: "derived" | "indeterminate";
}

export function normalizeGoalStatus(value: unknown): GoalStatus {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "completed" || raw === "complete" || raw === "done") return "completed";
  if (raw === "failed" || raw === "error" || raw === "errored") return "failed";
  if (raw === "blocked" || raw === "waitingforinput" || raw === "needsinput") return "blocked";
  if (raw === "paused" || raw === "interrupted") return "paused";
  if (raw === "active" || raw === "running" || raw === "inprogress" || raw === "in_progress") return "active";
  if (raw === "inactive" || raw === "idle" || raw === "none") return "inactive";
  return "active";
}

export function deriveGoalProgress(
  todos: ReadonlyArray<TodoItem>,
  status: GoalStatus | null | undefined,
  blockedSignals = 0,
): GoalProgressSummary {
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const running = todos.filter((todo) => todo.status === "in_progress").length;
  const pending = todos.filter((todo) => todo.status === "pending").length;
  const blocked = Math.max(0, blockedSignals);
  const total = todos.length > 0 ? todos.length : blocked > 0 ? blocked : 0;

  if (total > 0) {
    return {
      total,
      completed,
      running,
      blocked,
      pending,
      percentage: Math.round((completed / total) * 100),
      mode: "derived",
    };
  }

  if (status === "completed") {
    return {
      total: 1,
      completed: 1,
      running: 0,
      blocked: 0,
      pending: 0,
      percentage: 100,
      mode: "derived",
    };
  }

  return {
    total: 0,
    completed: 0,
    running: status === "active" ? 1 : 0,
    blocked: status === "blocked" || status === "failed" ? 1 : 0,
    pending: 0,
    percentage: null,
    mode: "indeterminate",
  };
}

export function resolveGoalElapsedMs(params: {
  readonly goal?: Pick<GoalSnapshot, "timeUsedSeconds"> | null;
  readonly streamElapsedMs?: number | null;
  readonly usage?: Pick<UsageData, "totalDurationMs"> | null;
}): number | null {
  if (params.goal?.timeUsedSeconds != null && params.goal.timeUsedSeconds >= 0) {
    return params.goal.timeUsedSeconds * 1000;
  }
  if (params.streamElapsedMs != null && params.streamElapsedMs > 0) {
    return params.streamElapsedMs;
  }
  if (params.usage?.totalDurationMs != null && params.usage.totalDurationMs > 0) {
    return params.usage.totalDurationMs;
  }
  return null;
}

export function resolveGoalTokens(params: {
  readonly goal?: Pick<GoalSnapshot, "tokensUsed" | "tokenBudget"> | null;
  readonly usage?: UsageData | null;
  readonly streamUsage?: StreamUsageData | null;
}): { used: number | null; budget: number | null } {
  const goalUsed = params.goal?.tokensUsed;
  const goalBudget = params.goal?.tokenBudget;
  if (goalUsed != null || goalBudget != null) {
    return {
      used: goalUsed ?? null,
      budget: goalBudget ?? null,
    };
  }

  const usageTokens = params.usage
    ? params.usage.inputTokens + params.usage.outputTokens + params.usage.cacheReadTokens + params.usage.cacheCreationTokens
    : 0;
  const streamTokens = params.streamUsage
    ? params.streamUsage.inputTokens + params.streamUsage.outputTokens + params.streamUsage.cacheReadTokens + params.streamUsage.cacheCreationTokens + params.streamUsage.estimatedOutputTokens
    : 0;
  const used = usageTokens + streamTokens;
  return {
    used: used > 0 ? used : null,
    budget: params.streamUsage?.contextWindow ?? params.usage?.contextWindow ?? null,
  };
}

export function formatGoalDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "--";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatGoalNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatGoalTokens(tokens: { readonly used: number | null; readonly budget: number | null }): string {
  if (tokens.used == null && tokens.budget == null) return "--";
  if (tokens.budget == null || tokens.budget <= 0) return formatGoalNumber(tokens.used);
  return `${formatGoalNumber(tokens.used)} / ${formatGoalNumber(tokens.budget)}`;
}

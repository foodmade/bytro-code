import type { ContextUsageData } from "@/stores/agent-status-store";
import type { TodoItem, UsageData } from "@/stores/chat-store";

/** Valid todo statuses used for validation when parsing DB data. */
const VALID_TODO_STATUSES = new Set<string>(["pending", "in_progress", "completed"]);

interface DbTodoRow {
  readonly content: string;
  readonly status: string;
  readonly active_form: string;
}

interface DbUsageRow {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
  readonly total_cost_usd: number;
  readonly context_window: number;
  readonly context_total_tokens?: number;
  readonly context_max_tokens?: number;
  readonly context_percentage?: number;
  readonly context_usage_updated_at?: number;
  readonly context_breakdown_json?: string | null;
  readonly model: string;
  readonly total_duration_ms: number;
}

function numberFromRecord(record: unknown, key: string): number | null {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function codexLastContextTokensFromSnapshot(json: string | null | undefined): number | null {
  if (!json) return null;
  try {
    const snapshot = JSON.parse(json) as unknown;
    if (!snapshot || typeof snapshot !== "object") return null;
    const record = snapshot as Record<string, unknown>;
    if (
      !record.total || typeof record.total !== "object"
      || !record.last || typeof record.last !== "object"
      || typeof record.modelContextWindow !== "number"
    ) {
      return null;
    }
    const last = record.last;
    const totalTokens = numberFromRecord(last, "totalTokens");
    if (totalTokens != null && totalTokens > 0) return totalTokens;
    const inputTokens = numberFromRecord(last, "inputTokens") ?? 0;
    const outputTokens = numberFromRecord(last, "outputTokens") ?? 0;
    const sum = inputTokens + outputTokens;
    return sum > 0 ? sum : null;
  } catch {
    return null;
  }
}

/** Parse a todo status string, defaulting to "pending" for unknown values. */
export function parseTodoStatus(status: string): TodoItem["status"] {
  return VALID_TODO_STATUSES.has(status)
    ? (status as TodoItem["status"])
    : "pending";
}

/** Convert a raw DB todo row to a typed TodoItem. */
function dbTodoToTodoItem(t: DbTodoRow): TodoItem {
  return {
    content: t.content,
    status: parseTodoStatus(t.status),
    activeForm: t.active_form,
  };
}

/** Convert an array of raw DB todo rows to typed TodoItems. */
export function parseDbTodos(
  dbTodos: ReadonlyArray<DbTodoRow>,
): ReadonlyArray<TodoItem> {
  return dbTodos.map(dbTodoToTodoItem);
}

/** Convert a DB usage row to the frontend UsageData shape. */
export function dbUsageToUsageData(db: DbUsageRow): UsageData {
  return {
    inputTokens: db.input_tokens,
    outputTokens: db.output_tokens,
    cacheReadTokens: db.cache_read_tokens,
    cacheCreationTokens: db.cache_creation_tokens,
    totalCostUsd: db.total_cost_usd,
    contextWindow: db.context_window,
    model: db.model,
    totalDurationMs: db.total_duration_ms,
  };
}

/** Convert persisted provider context usage data to frontend context usage shape. */
export function dbUsageToContextUsageData(db: DbUsageRow): ContextUsageData | null {
  const totalTokens = codexLastContextTokensFromSnapshot(db.context_breakdown_json)
    ?? db.context_total_tokens
    ?? 0;
  const maxTokens = db.context_max_tokens ?? 0;
  if (totalTokens <= 0 || maxTokens <= 0) return null;
  return {
    totalTokens,
    maxTokens,
    percentage: (totalTokens / maxTokens) * 100,
    updatedAt: db.context_usage_updated_at ?? 0,
    breakdownJson: db.context_breakdown_json ?? undefined,
  };
}

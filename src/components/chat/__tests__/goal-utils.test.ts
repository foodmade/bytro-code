import { describe, expect, it } from "vitest";
import {
  deriveGoalProgress,
  formatGoalDuration,
  formatGoalTokens,
  normalizeGoalStatus,
  resolveGoalElapsedMs,
  resolveGoalTokens,
} from "@/components/chat/goal-utils";
import type { TodoItem, UsageData } from "@/stores/chat-store";

const USAGE: UsageData = {
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 50,
  cacheCreationTokens: 0,
  totalCostUsd: 0,
  contextWindow: 200000,
  model: "gpt",
  totalDurationMs: 90_000,
};

describe("goal-utils", () => {
  it("normalizes goal status variants", () => {
    expect(normalizeGoalStatus("in_progress")).toBe("active");
    expect(normalizeGoalStatus("needsInput")).toBe("blocked");
    expect(normalizeGoalStatus("done")).toBe("completed");
  });

  it("derives progress from todos without faking empty progress", () => {
    const todos: TodoItem[] = [
      { content: "A", status: "completed", activeForm: "A" },
      { content: "B", status: "in_progress", activeForm: "B" },
      { content: "C", status: "pending", activeForm: "C" },
    ];

    expect(deriveGoalProgress(todos, "active")).toMatchObject({
      total: 3,
      completed: 1,
      running: 1,
      pending: 1,
      percentage: 33,
      mode: "derived",
    });

    expect(deriveGoalProgress([], "active")).toMatchObject({
      percentage: null,
      mode: "indeterminate",
    });
  });

  it("prefers app-server elapsed and token budget values", () => {
    expect(resolveGoalElapsedMs({
      goal: { timeUsedSeconds: 12 },
      streamElapsedMs: 30_000,
      usage: USAGE,
    })).toBe(12_000);

    expect(resolveGoalTokens({
      goal: { tokensUsed: 1234, tokenBudget: 40000 },
      usage: USAGE,
      streamUsage: null,
    })).toEqual({ used: 1234, budget: 40000 });
  });

  it("formats compact runtime values", () => {
    expect(formatGoalDuration(65_000)).toBe("1m 05s");
    expect(formatGoalTokens({ used: 1234, budget: 40000 })).toBe("1.2k / 40.0k");
  });
});

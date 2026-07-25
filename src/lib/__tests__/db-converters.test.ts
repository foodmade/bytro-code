import { describe, expect, it } from "vitest";
import { dbUsageToContextUsageData } from "../db-converters";

describe("dbUsageToContextUsageData", () => {
  const baseUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_window: 258000,
    context_max_tokens: 258000,
    context_usage_updated_at: 123,
    model: "gpt-5.5",
    total_duration_ms: 0,
  };

  it("uses Codex last tokenUsage snapshot instead of stale cumulative total", () => {
    const contextUsage = dbUsageToContextUsageData({
      ...baseUsage,
      context_total_tokens: 557499,
      context_percentage: 215.8,
      context_breakdown_json: JSON.stringify({
        total: { totalTokens: 557499 },
        last: {
          totalTokens: 73256,
          inputTokens: 71068,
          outputTokens: 2188,
          cachedInputTokens: 70016,
        },
        modelContextWindow: 258000,
      }),
    });

    expect(contextUsage?.totalTokens).toBe(73256);
    expect(contextUsage?.percentage).toBeCloseTo(28.3938);
  });

  it("falls back to stored context total for non-Codex snapshots", () => {
    const contextUsage = dbUsageToContextUsageData({
      ...baseUsage,
      context_total_tokens: 31400,
      context_percentage: 12.17,
      context_breakdown_json: JSON.stringify({ totalTokens: 31400, maxTokens: 258000 }),
    });

    expect(contextUsage?.totalTokens).toBe(31400);
    expect(contextUsage?.percentage).toBeCloseTo(12.1705);
  });

  it("does not treat non-Codex snapshots with a last field as Codex tokenUsage", () => {
    const contextUsage = dbUsageToContextUsageData({
      ...baseUsage,
      context_total_tokens: 31400,
      context_percentage: 12.17,
      context_breakdown_json: JSON.stringify({
        last: { totalTokens: 777 },
        totalTokens: 31400,
        maxTokens: 258000,
      }),
    });

    expect(contextUsage?.totalTokens).toBe(31400);
    expect(contextUsage?.percentage).toBeCloseTo(12.1705);
  });
});

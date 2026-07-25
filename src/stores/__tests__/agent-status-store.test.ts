import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAgentStatusStore, type StreamUsageData } from "@/stores/agent-status-store";
import type { UsageData } from "@/stores/chat-store";
import {
  getUsageTotal,
  resolveContextUsageTotal,
  resolveConversationUsageState,
} from "@/components/chat/context-usage-bar";
import { shouldShowCompactingForConversation } from "@/components/chat/agent-status-utils";

const USAGE_A: UsageData = {
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 100,
  cacheCreationTokens: 40,
  totalCostUsd: 0.12,
  contextWindow: 200000,
  model: "gpt-5.4",
  totalDurationMs: 5000,
};

const STREAM_A: Omit<StreamUsageData, "estimatedOutputTokens"> = {
  inputTokens: 500,
  outputTokens: 120,
  cacheReadTokens: 50,
  cacheCreationTokens: 0,
};

function resetAgentStatusStore() {
  useAgentStatusStore.setState({
    lastUsage: null,
    streamUsage: null,
    lastStreamUsage: null,
    contextUsage: null,
    lastTurnDurationMs: null,
    compacting: null,
    subagents: [],
    todos: [],
    _agentStatusCache: {},
  });
}

describe("useAgentStatusStore", () => {
  beforeEach(() => {
    resetAgentStatusStore();
  });

  afterEach(() => {
    resetAgentStatusStore();
  });

  it("tracks last turn duration on the live conversation", () => {
    const store = useAgentStatusStore.getState();
    store.setUsage(USAGE_A);
    store.addTurnDuration(2300);

    const state = useAgentStatusStore.getState();
    expect(state.lastUsage?.totalDurationMs).toBe(2300);
    expect(state.lastTurnDurationMs).toBe(2300);
  });

  it("isolates cached stream usage and output estimates per conversation", () => {
    const store = useAgentStatusStore.getState();
    store.setCachedStreamUsage("conv-a", STREAM_A);
    store.addCachedOutputTokenEstimate("conv-a", 17);
    store.setCachedStreamUsage("conv-b", {
      inputTokens: 30,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    const state = useAgentStatusStore.getState();
    expect(state._agentStatusCache["conv-a"]?.streamUsage).toMatchObject({
      ...STREAM_A,
      contextWindow: 0,
      estimatedOutputTokens: 5,
    });
    expect(state._agentStatusCache["conv-b"]?.streamUsage).toMatchObject({
      inputTokens: 30,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindow: 0,
      estimatedOutputTokens: 0,
    });
  });

  it("merges output-only stream usage without clearing input and cache counts", () => {
    const store = useAgentStatusStore.getState();
    store.setStreamUsage({
      inputTokens: 1281,
      outputTokens: 0,
      cacheReadTokens: 89088,
      cacheCreationTokens: 0,
    });
    store.setStreamUsage({
      inputTokens: 0,
      outputTokens: 315,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    expect(useAgentStatusStore.getState().streamUsage).toMatchObject({
      inputTokens: 1281,
      outputTokens: 315,
      cacheReadTokens: 89088,
      cacheCreationTokens: 0,
    });
    expect(useAgentStatusStore.getState().contextUsage).toBeNull();
  });

  it("resolves usage by target conversation instead of the active conversation", () => {
    useAgentStatusStore.setState({
      lastUsage: USAGE_A,
      streamUsage: {
        ...STREAM_A,
        estimatedOutputTokens: 0,
      },
      lastStreamUsage: {
        inputTokens: 300,
        outputTokens: 40,
        cacheReadTokens: 20,
        cacheCreationTokens: 0,
        estimatedOutputTokens: 0,
      },
      contextUsage: {
        totalTokens: 777,
        maxTokens: 200000,
        percentage: 0.3885,
      },
      lastTurnDurationMs: 1800,
      _agentStatusCache: {
        "conv-b": {
          todos: [],
          subagents: [],
          lastUsage: {
            ...USAGE_A,
            inputTokens: 50,
            outputTokens: 20,
            totalDurationMs: 900,
          },
          streamUsage: {
            inputTokens: 11,
            outputTokens: 7,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimatedOutputTokens: 0,
          },
          lastStreamUsage: null,
          contextUsage: {
            totalTokens: 67,
            maxTokens: 200000,
            percentage: 0.0335,
          },
          lastTurnDurationMs: 600,
        },
      },
    });

    const state = useAgentStatusStore.getState();
    const activeUsage = resolveConversationUsageState(state, "conv-a", "conv-a");
    const backgroundUsage = resolveConversationUsageState(state, "conv-b", "conv-a");

    expect(activeUsage.lastUsage?.inputTokens).toBe(1200);
    expect(activeUsage.streamUsage?.inputTokens).toBe(500);
    expect(activeUsage.lastStreamUsage?.inputTokens).toBe(300);
    expect(activeUsage.contextUsage?.totalTokens).toBe(777);
    expect(activeUsage.lastTurnDurationMs).toBe(1800);

    expect(backgroundUsage.lastUsage?.inputTokens).toBe(50);
    expect(backgroundUsage.streamUsage?.inputTokens).toBe(11);
    expect(backgroundUsage.lastStreamUsage).toBeNull();
    expect(backgroundUsage.contextUsage?.totalTokens).toBe(67);
    expect(backgroundUsage.lastTurnDurationMs).toBe(600);
  });

  it("counts cached tokens in billing totals", () => {
    expect(getUsageTotal(USAGE_A)).toBe(1640);
  });

  it("uses exact context snapshot instead of cumulative billing totals", () => {
    const cumulativeUsage: UsageData = {
      ...USAGE_A,
      inputTokens: 72229,
      outputTokens: 7504,
      cacheReadTokens: 636928,
      cacheCreationTokens: 0,
      contextWindow: 1000000,
    };

    expect(getUsageTotal(cumulativeUsage)).toBe(716661);
    expect(resolveContextUsageTotal({
      contextUsage: {
        totalTokens: 67700,
        maxTokens: 1000000,
        percentage: 6.77,
      },
      streamUsage: null,
      lastStreamUsage: null,
      isStreaming: false,
    })).toBe(67700);
  });

  it("updates context usage only from exact snapshots", () => {
    const store = useAgentStatusStore.getState();
    store.setStreamUsage({
      inputTokens: 111,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindow: 1000000,
    });

    expect(useAgentStatusStore.getState().contextUsage).toBeNull();

    store.setContextUsage({
      requestId: "exact-request",
      totalTokens: 31400,
      maxTokens: 1000000,
      percentage: 3.14,
      updatedAt: 100,
    });

    expect(useAgentStatusStore.getState().contextUsage).toMatchObject({
      requestId: "exact-request",
      totalTokens: 31400,
      maxTokens: 1000000,
      percentage: 3.14,
    });
  });

  it("ignores stale exact context snapshots after a newer estimate", () => {
    const store = useAgentStatusStore.getState();
    store.setContextUsage({
      requestId: "newer-request",
      totalTokens: 31400,
      maxTokens: 1000000,
      percentage: 3.14,
      updatedAt: 200,
    });
    store.setContextUsage({
      requestId: "older-request",
      totalTokens: 111,
      maxTokens: 1000000,
      percentage: 0.0111,
      updatedAt: 100,
    });

    expect(useAgentStatusStore.getState().contextUsage).toMatchObject({
      requestId: "newer-request",
      totalTokens: 31400,
      maxTokens: 1000000,
    });
  });

  it("does not let stream usage replace an exact context snapshot", () => {
    const store = useAgentStatusStore.getState();
    store.setContextUsage({
      requestId: "exact-request",
      totalTokens: 31400,
      maxTokens: 1000000,
      percentage: 3.14,
      updatedAt: 100,
    });
    store.setStreamUsage({
      requestId: "next-request",
      inputTokens: 111,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindow: 1000000,
    });

    expect(useAgentStatusStore.getState().contextUsage).toMatchObject({
      requestId: "exact-request",
      totalTokens: 31400,
    });
  });

  it("keeps context snapshot when output-only stream usage arrives", () => {
    const store = useAgentStatusStore.getState();
    store.setContextUsage({
      totalTokens: 31400,
      maxTokens: 1000000,
      percentage: 3.14,
      updatedAt: 100,
    });
    store.setStreamUsage({
      inputTokens: 0,
      outputTokens: 315,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindow: 0,
    });

    const contextUsage = useAgentStatusStore.getState().contextUsage;
    expect(contextUsage?.totalTokens).toBe(31400);
    expect(contextUsage?.maxTokens).toBe(1000000);
    expect(contextUsage?.percentage).toBeCloseTo(3.14);
  });

  it("returns zero when no exact context snapshot exists", () => {
    const inputOnlyStream: StreamUsageData = {
      inputTokens: 191,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedOutputTokens: 0,
    };

    expect(resolveContextUsageTotal({
      contextUsage: null,
      streamUsage: inputOnlyStream,
      lastStreamUsage: null,
      isStreaming: true,
    })).toBe(0);
  });

  it("keeps queued mid-stream compaction active until the compact turn starts", () => {
    const store = useAgentStatusStore.getState();
    store.setCompacting("manual", 0, "conv-a", true);

    store.clearCompacting("conv-a");
    expect(useAgentStatusStore.getState().compacting).toMatchObject({
      active: true,
      pendingNextTurn: true,
    });

    store.activatePendingCompacting("conv-a");
    expect(useAgentStatusStore.getState().compacting).toMatchObject({
      active: true,
      pendingNextTurn: false,
    });

    store.clearCompacting("conv-a");
    expect(useAgentStatusStore.getState().compacting).toBeNull();
  });

  it("preserves pending-next-turn when compact boundary arrives before queued turn starts", () => {
    const store = useAgentStatusStore.getState();
    store.setCompacting("manual", 0, "conv-a", true);

    store.setCompacting("manual", 123, "conv-a");

    expect(useAgentStatusStore.getState().compacting).toMatchObject({
      preTokens: 123,
      pendingNextTurn: true,
    });
  });

  it("force-clears queued mid-stream compaction on send failure", () => {
    const store = useAgentStatusStore.getState();
    store.setCompacting("manual", 0, "conv-a", true);

    store.clearCompacting("conv-a", true);

    expect(useAgentStatusStore.getState().compacting).toBeNull();
  });

  it("shows compacting only for the matching conversation", () => {
    const store = useAgentStatusStore.getState();
    store.setCompacting("manual", 0, "conv-b");

    const compacting = useAgentStatusStore.getState().compacting;
    expect(shouldShowCompactingForConversation(compacting, "conv-b")).toBe(true);
    expect(shouldShowCompactingForConversation(compacting, "conv-a")).toBe(false);
  });

  it("keeps legacy compacting state without a conversation id visible", () => {
    const store = useAgentStatusStore.getState();
    store.setCompacting("auto", 10);

    expect(shouldShowCompactingForConversation(
      useAgentStatusStore.getState().compacting,
      "conv-a",
    )).toBe(true);
  });

  it("records subagent prompt, progress trail, and final result", () => {
    const store = useAgentStatusStore.getState();
    store.addSubagent("agent-1", "codex-collab", "Research", "Investigate SDK support", undefined, "Read docs and summarize agent tracing");
    store.updateSubagentProgress(undefined, {
      toolUses: 1,
      lastToolName: "WebSearch",
      summary: "Searching official docs",
    }, "agent-1");
    store.completeSubagentTask(undefined, {
      status: "completed",
      summary: "Finished",
      result: "Found tracing and handoff support, but not raw full reasoning.",
    }, "agent-1");

    const subagent = useAgentStatusStore.getState().subagents[0];
    expect(subagent?.prompt).toBe("Read docs and summarize agent tracing");
    expect(subagent?.toolCountMap?.WebSearch).toBe(1);
    expect(subagent?.finalResult).toContain("tracing");
    expect(subagent?.toolHistory?.map((entry) => entry.toolName)).toEqual(["WebSearch"]);
    expect(subagent?.finalStatus).toBe("completed");
  });
});

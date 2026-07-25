import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { UsageData, SubagentInfo, TodoItem } from "./chat-types";

function mergeTokenCount(next: number | undefined, prev: number | undefined): number {
  return next != null && next > 0 ? next : (prev ?? 0);
}

type SubagentProgressUpdate = {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
  readonly lastToolName?: string;
  readonly summary?: string;
};

type SubagentTaskCompletion = {
  readonly status: string;
  readonly summary?: string;
  readonly result?: string;
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
};

/** Real-time token usage from stream events (per API turn). */
export interface StreamUsageData {
  readonly requestId?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly contextWindow?: number;
  /** Estimated output tokens based on accumulated text length (updated per delta). */
  readonly estimatedOutputTokens: number;
}

/** Current context-window usage from provider snapshots. */
export interface ContextUsageData {
  readonly requestId?: string;
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly percentage: number;
  readonly updatedAt?: number;
  readonly breakdownJson?: string;
}

function shouldReplaceContextUsage(
  next: ContextUsageData,
  prev: ContextUsageData | null | undefined,
): boolean {
  if (!prev) return true;
  if (next.updatedAt == null || prev.updatedAt == null) return true;
  return next.updatedAt >= prev.updatedAt;
}

/** Per-conversation cache for todos, subagents and usage so they survive conversation switches */
interface AgentStatusSnapshot {
  readonly todos: ReadonlyArray<TodoItem>;
  readonly subagents: ReadonlyArray<SubagentInfo>;
  readonly lastUsage: UsageData | null;
  readonly streamUsage: StreamUsageData | null;
  readonly lastStreamUsage: StreamUsageData | null;
  readonly contextUsage: ContextUsageData | null;
  readonly lastTurnDurationMs: number | null;
}

/** Context compaction state set when the Claude SDK emits a compact_boundary. */
export interface CompactingState {
  readonly active: boolean;
  readonly trigger: "auto" | "manual";
  readonly preTokens: number;
  readonly conversationId?: string | null;
  readonly pendingNextTurn?: boolean;
}

interface AgentStatusState {
  readonly lastUsage: UsageData | null;
  /** Real-time per-turn token usage from stream events (message_start/delta). */
  readonly streamUsage: StreamUsageData | null;
  /** Snapshot of the last completed turn's stream usage — survives stream end so the
   *  status bar can continue displaying token stats after the turn finishes. */
  readonly lastStreamUsage: StreamUsageData | null;
  /** Current context-window estimate from the latest request input snapshot. */
  readonly contextUsage: ContextUsageData | null;
  /** Duration (ms) of the last completed turn for the live conversation. */
  readonly lastTurnDurationMs: number | null;
  /** Whether the Claude SDK is currently compacting context. */
  readonly compacting: CompactingState | null;
  /** CLI-reported Claude fast-mode state from the latest system_init: "on" | "off" | "cooldown" | null. */
  readonly claudeFastModeState: string | null;
  /** Tool names from the latest Claude system_init — used by /status to show
   *  whether session-level features actually loaded (e.g. the Workflow tool
   *  proves ultracode's dynamic-workflow half is active). */
  readonly claudeSessionTools: ReadonlyArray<string> | null;
  readonly subagents: ReadonlyArray<SubagentInfo>;
  readonly todos: ReadonlyArray<TodoItem>;
  /** Per-conversation agent status cache -- preserves todos/subagents across switches */
  readonly _agentStatusCache: Record<string, AgentStatusSnapshot>;
  readonly setUsage: (usage: UsageData) => void;
  readonly clearUsage: () => void;
  /** Set real-time stream usage from message_start / message_delta events. */
  readonly setStreamUsage: (usage: Omit<StreamUsageData, "estimatedOutputTokens">) => void;
  /** Set current context-window usage from provider snapshots. */
  readonly setContextUsage: (usage: ContextUsageData) => void;
  /** Set the CLI-reported Claude fast-mode state (from system_init). */
  readonly setClaudeFastModeState: (state: string | null) => void;
  /** Set the tool list from the latest Claude system_init. */
  readonly setClaudeSessionTools: (tools: ReadonlyArray<string> | null) => void;
  /** Increment estimated output tokens from text delta character count. */
  readonly addOutputTokenEstimate: (charCount: number) => void;
  readonly clearStreamUsage: () => void;
  /** Mark that the Claude SDK has started compacting context. */
  readonly setCompacting: (trigger: "auto" | "manual", preTokens: number, conversationId?: string | null, pendingNextTurn?: boolean) => void;
  readonly activatePendingCompacting: (conversationId?: string | null) => void;
  /** Clear the compacting state (compaction finished). */
  readonly clearCompacting: (conversationId?: string | null, force?: boolean) => void;
  readonly addSubagent: (agentId: string, agentType: string, name?: string, description?: string, sessionId?: string, prompt?: string) => void;
  readonly removeSubagent: (agentId: string) => void;
  readonly setTodos: (todos: ReadonlyArray<TodoItem>) => void;
  /** Merge incoming todos with existing (update matching content, append new) */
  readonly mergeTodos: (incoming: ReadonlyArray<TodoItem>) => void;
  /** Persist todos to database for a conversation */
  readonly persistTodos: (conversationId: string, todos: ReadonlyArray<TodoItem>) => Promise<void>;
  /** Persist usage to database for a conversation */
  readonly persistUsage: (conversationId: string, usage: UsageData) => Promise<void>;
  /** Add a completed turn's duration to the cumulative session total. */
  readonly addTurnDuration: (durationMs: number) => void;
  /** Add a completed turn's duration to a cached background conversation. */
  readonly addCachedTurnDuration: (conversationId: string, durationMs: number) => void;
  readonly finalizeAgentTurn: () => void;
  /** Mark all pending/in_progress todos as completed when a session ends */
  readonly completePendingTodos: () => void;
  readonly clearAgentStatus: () => void;
  /** Save current todos/subagents into the agent status cache for a conversation */
  readonly cacheAgentStatus: (conversationId: string) => void;
  /** Update cached usage for a background conversation */
  readonly updateCachedUsage: (conversationId: string, usage: UsageData) => void;
  /** Replace cached cumulative usage for a background conversation. */
  readonly setCachedUsage: (conversationId: string, usage: UsageData | null) => void;
  /** Set cached context-window usage from provider snapshots. */
  readonly setCachedContextUsage: (conversationId: string, usage: ContextUsageData) => void;
  /** Persist context-window usage to database. */
  readonly persistContextUsage: (conversationId: string, usage: ContextUsageData) => Promise<void>;
  /** Set real-time stream usage for a background conversation. */
  readonly setCachedStreamUsage: (
    conversationId: string,
    usage: Omit<StreamUsageData, "estimatedOutputTokens">,
  ) => void;
  /** Increment estimated output tokens for a background conversation. */
  readonly addCachedOutputTokenEstimate: (conversationId: string, charCount: number) => void;
  /** Clear real-time stream usage for a background conversation. */
  readonly clearCachedStreamUsage: (conversationId: string) => void;
  /** Update cached todos for a background conversation */
  readonly updateCachedTodos: (conversationId: string, todos: ReadonlyArray<TodoItem>) => void;
  /** Add a subagent to the cache for a background conversation */
  readonly addCachedSubagent: (conversationId: string, agentId: string, agentType: string, name?: string, description?: string, sessionId?: string, prompt?: string) => void;
  /** Mark a cached subagent as stopped for a background conversation */
  readonly removeCachedSubagent: (conversationId: string, agentId: string) => void;
  /** Associate a task_id with a subagent (live). `name` backfills the display
   *  name for subagents that arrived without one (e.g. workflow-spawned agents,
   *  whose SubagentStart hook carries no description). */
  readonly setSubagentTaskId: (agentId: string, taskId: string, name?: string) => void;
  /** Update subagent progress from task_progress event (live) */
  readonly updateSubagentProgress: (taskId: string | undefined, progress: SubagentProgressUpdate, agentId?: string) => void;
  /** Record subagent task completion from task_notification event (live) */
  readonly completeSubagentTask: (taskId: string | undefined, notification: SubagentTaskCompletion, agentId?: string) => void;
  /** Associate a task_id with a cached subagent (background). `name` backfills
   *  a missing display name (see setSubagentTaskId). */
  readonly setCachedSubagentTaskId: (conversationId: string, agentId: string, taskId: string, name?: string) => void;
  /** Update cached subagent progress (background) */
  readonly updateCachedSubagentProgress: (conversationId: string, taskId: string | undefined, progress: SubagentProgressUpdate, agentId?: string) => void;
  /** Record cached subagent task completion (background) */
  readonly completeCachedSubagentTask: (conversationId: string, taskId: string | undefined, notification: SubagentTaskCompletion, agentId?: string) => void;
  /** Finalize agent turn in cache for a background conversation */
  readonly finalizeCachedAgentTurn: (conversationId: string) => void;
  /** Append a subagent text delta (live) — accumulates natural-language reply. */
  readonly appendSubagentTextDelta: (sessionId: string, delta: string) => void;
  /** Append a subagent thinking delta (live). */
  readonly appendSubagentThinkingDelta: (
    sessionId: string,
    delta: string,
    startNewBlock?: boolean,
  ) => void;
  /** Append a subagent text delta to a cached background conversation. */
  readonly appendCachedSubagentTextDelta: (
    conversationId: string,
    sessionId: string,
    delta: string,
  ) => void;
  /** Append a subagent thinking delta to a cached background conversation. */
  readonly appendCachedSubagentThinkingDelta: (
    conversationId: string,
    sessionId: string,
    delta: string,
    startNewBlock?: boolean,
  ) => void;
  /** Mark all pending/in_progress cached todos as completed for a background conversation */
  readonly completeCachedPendingTodos: (conversationId: string) => void;
  /** Restore cached agent status for a conversation (returns snapshot and removes from cache) */
  readonly popCachedAgentStatus: (conversationId: string) => AgentStatusSnapshot | undefined;
  /** Reset live agent status fields (usage, subagents, todos) */
  readonly resetLiveStatus: (status: {
    lastUsage: UsageData | null;
    subagents: ReadonlyArray<SubagentInfo>;
    todos: ReadonlyArray<TodoItem>;
    streamUsage?: StreamUsageData | null;
    lastStreamUsage?: StreamUsageData | null;
    contextUsage?: ContextUsageData | null;
    lastTurnDurationMs?: number | null;
  }) => void;
}

export const useAgentStatusStore = create<AgentStatusState>((set, get) => ({
  lastUsage: null,
  streamUsage: null,
  lastStreamUsage: null,
  contextUsage: null,
  lastTurnDurationMs: null,
  compacting: null,
  claudeFastModeState: null,
  claudeSessionTools: null,
  subagents: [],
  todos: [],
  _agentStatusCache: {},

  setStreamUsage: (usage) => {
    const prev = get().streamUsage;
    const contextWindow = usage.contextWindow ?? prev?.contextWindow ?? get().contextUsage?.maxTokens ?? 0;
    // message_start sets input fields; message_delta sets output fields.
    // Merge rather than replace so both coexist.
    set({
      streamUsage: {
        requestId: usage.requestId ?? prev?.requestId,
        inputTokens: mergeTokenCount(usage.inputTokens, prev?.inputTokens),
        outputTokens: mergeTokenCount(usage.outputTokens, prev?.outputTokens),
        cacheReadTokens: mergeTokenCount(usage.cacheReadTokens, prev?.cacheReadTokens),
        cacheCreationTokens: mergeTokenCount(usage.cacheCreationTokens, prev?.cacheCreationTokens),
        contextWindow,
        estimatedOutputTokens: prev?.estimatedOutputTokens ?? 0,
      },
      // New turn started — clear the snapshot from the previous turn
      ...(prev == null ? { lastStreamUsage: null, lastTurnDurationMs: null } : {}),
    });
  },
  setContextUsage: (usage) =>
    set((state) => shouldReplaceContextUsage(usage, state.contextUsage)
      ? { contextUsage: usage }
      : {}),
  addOutputTokenEstimate: (charCount) => {
    const prev = get().streamUsage;
    // ~4 chars per token is the standard heuristic for English text
    const tokenEstimate = Math.ceil(charCount / 4);
    set({
      streamUsage: {
        requestId: prev?.requestId,
        inputTokens: prev?.inputTokens ?? 0,
        outputTokens: prev?.outputTokens ?? 0,
        cacheReadTokens: prev?.cacheReadTokens ?? 0,
        cacheCreationTokens: prev?.cacheCreationTokens ?? 0,
        contextWindow: prev?.contextWindow,
        estimatedOutputTokens: (prev?.estimatedOutputTokens ?? 0) + tokenEstimate,
      },
    });
  },
  clearStreamUsage: () => {
    const current = get().streamUsage;
    set({
      streamUsage: null,
      // Preserve the last turn's usage so the status bar keeps showing it
      lastStreamUsage: current ?? get().lastStreamUsage,
    });
  },

  setCompacting: (trigger, preTokens, conversationId, pendingNextTurn) =>
    set((state) => {
      const current = state.compacting;
      const sameConversation = current?.conversationId === conversationId;
      return {
        compacting: {
          active: true,
          trigger,
          preTokens,
          conversationId,
          pendingNextTurn: pendingNextTurn ?? (sameConversation ? current?.pendingNextTurn : undefined),
        },
      };
    }),
  activatePendingCompacting: (conversationId) =>
    set((state) => {
      const current = state.compacting;
      if (!current?.pendingNextTurn) return {};
      if (conversationId && current.conversationId && current.conversationId !== conversationId) return {};
      return { compacting: { ...current, pendingNextTurn: false } };
    }),
  clearCompacting: (conversationId, force) =>
    set((state) => {
      const current = state.compacting;
      if (!current) return {};
      if (conversationId && current.conversationId && current.conversationId !== conversationId) return {};
      if (current.pendingNextTurn && !force) return {};
      return { compacting: null };
    }),

  setUsage: (usage) => {
    const prev = get().lastUsage;
    set({
      lastUsage: {
        inputTokens: (prev?.inputTokens ?? 0) + usage.inputTokens,
        outputTokens: (prev?.outputTokens ?? 0) + usage.outputTokens,
        cacheReadTokens: (prev?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
        cacheCreationTokens: (prev?.cacheCreationTokens ?? 0) + usage.cacheCreationTokens,
        totalCostUsd: (prev?.totalCostUsd ?? 0) + usage.totalCostUsd,
        contextWindow: usage.contextWindow,
        model: usage.model,
        // Duration is accumulated separately via addTurnDuration (called from chat-done handler)
        totalDurationMs: prev?.totalDurationMs ?? 0,
      },
    });
  },
  clearUsage: () => set({ lastUsage: null, contextUsage: null, lastTurnDurationMs: null }),
  setClaudeFastModeState: (state) => set({ claudeFastModeState: state }),
  setClaudeSessionTools: (tools) => set({ claudeSessionTools: tools }),
  addSubagent: (agentId, agentType, name, description, sessionId, prompt) =>
    set((state) => {
      if (state.subagents.some((sa) => sa.agentId === agentId)) {
        return state;
      }
      return {
        subagents: [
          ...state.subagents,
          {
            agentId,
            agentType,
            name,
            description,
            prompt,
            sessionId,
            status: "active" as const,
          },
        ],
      };
    }),
  removeSubagent: (agentId) =>
    set((state) => ({
      subagents: state.subagents.map((sa) =>
        sa.agentId === agentId
          ? { ...sa, status: "stopped" as const, thinkingActive: false, textActive: false }
          : sa,
      ),
    })),
  setTodos: (todos) => set({ todos }),
  mergeTodos: (incoming) =>
    set((state) => {
      const merged = incoming.reduce(
        (acc, todo) => {
          const idx = acc.findIndex((t) => t.content === todo.content);
          if (idx >= 0) {
            return [...acc.slice(0, idx), todo, ...acc.slice(idx + 1)];
          }
          return [...acc, todo];
        },
        [...state.todos],
      );
      return { todos: merged };
    }),
  persistTodos: async (conversationId: string, todos: ReadonlyArray<TodoItem>) => {
    try {
      await invoke("save_conversation_todos", {
        conversationId,
        todos: todos.map((t) => ({
          content: t.content,
          status: t.status,
          active_form: t.activeForm,
        })),
      });
    } catch {
      // Non-critical: todo persistence is best-effort
    }
  },
  persistUsage: async (conversationId: string, usage: UsageData) => {
    try {
      await invoke("save_conversation_usage", {
        conversationId,
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_tokens: usage.cacheReadTokens,
          cache_creation_tokens: usage.cacheCreationTokens,
          total_cost_usd: usage.totalCostUsd,
          context_window: usage.contextWindow,
          model: usage.model,
          total_duration_ms: usage.totalDurationMs,
        },
      });
    } catch {
      // Non-critical: usage persistence is best-effort
    }
  },
  persistContextUsage: async (conversationId, usage) => {
    try {
      await invoke("save_conversation_context_usage", {
        conversationId,
        usage: {
          total_tokens: usage.totalTokens,
          max_tokens: usage.maxTokens,
          percentage: usage.percentage,
          updated_at: usage.updatedAt ?? Date.now(),
          breakdown_json: usage.breakdownJson,
        },
      });
    } catch {
      // Non-critical: context usage persistence is best-effort
    }
  },
  addTurnDuration: (durationMs) => {
    const usage = get().lastUsage;
    if (!usage || durationMs <= 0) return;
    set({
      lastUsage: { ...usage, totalDurationMs: usage.totalDurationMs + durationMs },
      lastTurnDurationMs: durationMs,
    });
  },
  addCachedTurnDuration: (conversationId, durationMs) => {
    if (durationMs <= 0) return;
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    const usage = existing?.lastUsage;
    if (!usage) return;
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: {
          ...existing,
          lastTurnDurationMs: durationMs,
          lastUsage: { ...usage, totalDurationMs: usage.totalDurationMs + durationMs },
        },
      },
    });
  },
  finalizeAgentTurn: () =>
    set((state) => ({
      subagents: state.subagents.map((sa) =>
        sa.status === "active"
          ? { ...sa, status: "stopped" as const, thinkingActive: false, textActive: false }
          : { ...sa, thinkingActive: false, textActive: false },
      ),
    })),
  completePendingTodos: () =>
    set((state) => {
      const hasIncomplete = state.todos.some((t) => t.status !== "completed");
      if (!hasIncomplete) return state;
      return {
        todos: state.todos.map((t) =>
          t.status === "pending" || t.status === "in_progress"
            ? { ...t, status: "completed" as const }
            : t,
        ),
      };
    }),
  clearAgentStatus: () => set({ subagents: [], todos: [] }),

  cacheAgentStatus: (conversationId: string) => {
    const {
      todos,
      subagents,
      lastUsage,
      streamUsage,
      lastStreamUsage,
      contextUsage,
      lastTurnDurationMs,
      _agentStatusCache,
    } = get();
    // Always cache — even when all fields are empty/null — so that
    // popCachedAgentStatus reliably returns the correct (empty) state
    // instead of falling through to a potentially stale DB record.
    set({
      _agentStatusCache: {
        ..._agentStatusCache,
        [conversationId]: {
          todos,
          subagents,
          lastUsage,
          streamUsage,
          lastStreamUsage,
          contextUsage,
          lastTurnDurationMs,
        },
      },
    });
  },

  updateCachedUsage: (conversationId: string, usage: UsageData) => {
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    const prev = existing?.lastUsage;
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: {
          todos: existing?.todos ?? [],
          subagents: existing?.subagents ?? [],
          streamUsage: existing?.streamUsage ?? null,
          lastStreamUsage: existing?.lastStreamUsage ?? null,
          contextUsage: existing?.contextUsage ?? null,
          lastTurnDurationMs: existing?.lastTurnDurationMs ?? null,
          lastUsage: {
            inputTokens: (prev?.inputTokens ?? 0) + usage.inputTokens,
            outputTokens: (prev?.outputTokens ?? 0) + usage.outputTokens,
            cacheReadTokens: (prev?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
            cacheCreationTokens: (prev?.cacheCreationTokens ?? 0) + usage.cacheCreationTokens,
            totalCostUsd: (prev?.totalCostUsd ?? 0) + usage.totalCostUsd,
            contextWindow: usage.contextWindow,
            model: usage.model,
            // Duration is accumulated separately via addCachedTurnDuration
            totalDurationMs: prev?.totalDurationMs ?? 0,
          },
        },
      },
    });
  },

  setCachedUsage: (conversationId: string, usage: UsageData | null) => {
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: {
          todos: existing?.todos ?? [],
          subagents: existing?.subagents ?? [],
          streamUsage: existing?.streamUsage ?? null,
          lastStreamUsage: existing?.lastStreamUsage ?? null,
          contextUsage: existing?.contextUsage ?? null,
          lastTurnDurationMs: existing?.lastTurnDurationMs ?? null,
          lastUsage: usage,
        },
      },
    });
  },

  setCachedContextUsage: (conversationId, usage) => {
    set((state) => {
      const cache = state._agentStatusCache;
      const existing = cache[conversationId];
      return {
        _agentStatusCache: {
          ...cache,
          [conversationId]: {
            todos: existing?.todos ?? [],
            subagents: existing?.subagents ?? [],
            lastUsage: existing?.lastUsage ?? null,
            streamUsage: existing?.streamUsage ?? null,
            lastStreamUsage: existing?.lastStreamUsage ?? null,
            contextUsage: shouldReplaceContextUsage(usage, existing?.contextUsage)
              ? usage
              : (existing?.contextUsage ?? null),
            lastTurnDurationMs: existing?.lastTurnDurationMs ?? null,
          },
        },
      };
    });
  },

  setCachedStreamUsage: (conversationId, usage) => {
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    const prev = existing?.streamUsage;
    const contextWindow = usage.contextWindow ?? prev?.contextWindow ?? existing?.contextUsage?.maxTokens ?? 0;
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: {
          todos: existing?.todos ?? [],
          subagents: existing?.subagents ?? [],
          lastUsage: existing?.lastUsage ?? null,
          lastTurnDurationMs: prev == null ? null : (existing?.lastTurnDurationMs ?? null),
          contextUsage: existing?.contextUsage ?? null,
          streamUsage: {
            requestId: usage.requestId ?? prev?.requestId,
            inputTokens: mergeTokenCount(usage.inputTokens, prev?.inputTokens),
            outputTokens: mergeTokenCount(usage.outputTokens, prev?.outputTokens),
            cacheReadTokens: mergeTokenCount(usage.cacheReadTokens, prev?.cacheReadTokens),
            cacheCreationTokens: mergeTokenCount(usage.cacheCreationTokens, prev?.cacheCreationTokens),
            contextWindow,
            estimatedOutputTokens: prev?.estimatedOutputTokens ?? 0,
          },
          lastStreamUsage: prev == null ? null : (existing?.lastStreamUsage ?? null),
        },
      },
    });
  },

  addCachedOutputTokenEstimate: (conversationId, charCount) => {
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    const prev = existing?.streamUsage;
    const tokenEstimate = Math.ceil(charCount / 4);
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: {
          todos: existing?.todos ?? [],
          subagents: existing?.subagents ?? [],
          lastUsage: existing?.lastUsage ?? null,
          lastStreamUsage: existing?.lastStreamUsage ?? null,
          contextUsage: existing?.contextUsage ?? null,
          lastTurnDurationMs: existing?.lastTurnDurationMs ?? null,
          streamUsage: {
            requestId: prev?.requestId,
            inputTokens: prev?.inputTokens ?? 0,
            outputTokens: prev?.outputTokens ?? 0,
            cacheReadTokens: prev?.cacheReadTokens ?? 0,
            cacheCreationTokens: prev?.cacheCreationTokens ?? 0,
            contextWindow: prev?.contextWindow,
            estimatedOutputTokens: (prev?.estimatedOutputTokens ?? 0) + tokenEstimate,
          },
        },
      },
    });
  },

  clearCachedStreamUsage: (conversationId) => {
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    if (!existing) return;
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: {
          ...existing,
          streamUsage: null,
          lastStreamUsage: existing.streamUsage ?? existing.lastStreamUsage,
        },
      },
    });
  },

  updateCachedTodos: (conversationId: string, todos: ReadonlyArray<TodoItem>) => {
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    const currentTodos = [...(existing?.todos ?? [])];
    for (const todo of todos) {
      const idx = currentTodos.findIndex((t) => t.content === todo.content);
      if (idx >= 0) {
        currentTodos[idx] = todo;
      } else {
        currentTodos.push(todo);
      }
    }
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: {
          subagents: existing?.subagents ?? [],
          todos: currentTodos,
          lastUsage: existing?.lastUsage ?? null,
          streamUsage: existing?.streamUsage ?? null,
          lastStreamUsage: existing?.lastStreamUsage ?? null,
          contextUsage: existing?.contextUsage ?? null,
          lastTurnDurationMs: existing?.lastTurnDurationMs ?? null,
        },
      },
    });
  },

  addCachedSubagent: (conversationId: string, agentId: string, agentType: string, name?: string, description?: string, sessionId?: string, prompt?: string) => {
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    const currentSubagents = existing?.subagents ?? [];
    if (currentSubagents.some((sa) => sa.agentId === agentId)) return;
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: {
          todos: existing?.todos ?? [],
          subagents: [
            ...currentSubagents,
            {
              agentId,
              agentType,
              name,
              description,
              prompt,
              sessionId,
              status: "active" as const,
            },
          ],
          lastUsage: existing?.lastUsage ?? null,
          streamUsage: existing?.streamUsage ?? null,
          lastStreamUsage: existing?.lastStreamUsage ?? null,
          contextUsage: existing?.contextUsage ?? null,
          lastTurnDurationMs: existing?.lastTurnDurationMs ?? null,
        },
      },
    });
  },

  removeCachedSubagent: (conversationId: string, agentId: string) => {
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    if (!existing) return;
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: {
          ...existing,
          subagents: existing.subagents.map((sa) =>
            sa.agentId === agentId
              ? { ...sa, status: "stopped" as const, thinkingActive: false, textActive: false }
              : sa,
          ),
        },
      },
    });
  },

  // -- Task progress actions (live) --

  setSubagentTaskId: (agentId: string, taskId: string, name?: string) =>
    set((state) => ({
      subagents: state.subagents.map((sa) =>
        sa.agentId === agentId ? { ...sa, taskId, name: sa.name ?? name } : sa,
      ),
    })),

  updateSubagentProgress: (taskId, progress, agentId) =>
    set((state) => ({
      subagents: state.subagents.map((sa) => {
        if ((taskId && sa.taskId !== taskId) || (!taskId && agentId && sa.agentId !== agentId)) return sa;
        if (!taskId && !agentId) return sa;
        const newToolName = progress.lastToolName ?? sa.lastToolName;
        const toolChanged = newToolName && newToolName !== sa.lastToolName;
        // Compute per-tool count delta from toolUses change
        const prevToolUses = sa.toolUses ?? 0;
        const newToolUses = progress.toolUses ?? prevToolUses;
        const delta = newToolUses - prevToolUses;
        const currentTool = progress.lastToolName ?? sa.lastToolName;
        const newToolCountMap = (delta > 0 && currentTool)
          ? { ...(sa.toolCountMap ?? {}), [currentTool]: ((sa.toolCountMap ?? {})[currentTool] ?? 0) + delta }
          : sa.toolCountMap;
        return {
          ...sa,
          totalTokens: progress.totalTokens ?? sa.totalTokens,
          inputTokens: progress.inputTokens ?? sa.inputTokens,
          outputTokens: progress.outputTokens ?? sa.outputTokens,
          cacheReadTokens: progress.cacheReadTokens ?? sa.cacheReadTokens,
          cacheCreationTokens: progress.cacheCreationTokens ?? sa.cacheCreationTokens,
          toolUses: newToolUses,
          durationMs: progress.durationMs ?? sa.durationMs,
          lastToolName: newToolName,
          progressSummary: progress.summary ?? sa.progressSummary,
          toolHistory: toolChanged
            ? [...(sa.toolHistory ?? []), { toolName: newToolName!, timestamp: Date.now() }]
            : sa.toolHistory,
          toolCountMap: newToolCountMap,
        };
      }),
    })),

  completeSubagentTask: (taskId, notification, agentId) =>
    set((state) => ({
      subagents: state.subagents.map((sa) =>
        ((taskId && sa.taskId === taskId) || (!taskId && agentId && sa.agentId === agentId))
          ? {
              ...sa,
              finalStatus: notification.status,
              finalSummary: notification.summary,
              finalResult: notification.result ?? sa.finalResult,
              totalTokens: notification.totalTokens ?? sa.totalTokens,
              inputTokens: notification.inputTokens ?? sa.inputTokens,
              outputTokens: notification.outputTokens ?? sa.outputTokens,
              cacheReadTokens: notification.cacheReadTokens ?? sa.cacheReadTokens,
              cacheCreationTokens: notification.cacheCreationTokens ?? sa.cacheCreationTokens,
              toolUses: notification.toolUses ?? sa.toolUses,
              durationMs: notification.durationMs ?? sa.durationMs,
            }
          : sa,
      ),
    })),

  // -- Task progress actions (cached / background) --

  setCachedSubagentTaskId: (conversationId: string, agentId: string, taskId: string, name?: string) => {
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    if (!existing) return;
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: {
          ...existing,
          subagents: existing.subagents.map((sa) =>
            sa.agentId === agentId ? { ...sa, taskId, name: sa.name ?? name } : sa,
          ),
        },
      },
    });
  },

  updateCachedSubagentProgress: (conversationId: string, taskId: string | undefined, progress, agentId?: string) => {
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    if (!existing) return;
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: {
          ...existing,
          subagents: existing.subagents.map((sa) => {
            if ((taskId && sa.taskId !== taskId) || (!taskId && agentId && sa.agentId !== agentId)) return sa;
            if (!taskId && !agentId) return sa;
            const newToolName = progress.lastToolName ?? sa.lastToolName;
            const toolChanged = newToolName && newToolName !== sa.lastToolName;
            // Compute per-tool count delta from toolUses change
            const prevToolUses = sa.toolUses ?? 0;
            const newToolUses = progress.toolUses ?? prevToolUses;
            const delta = newToolUses - prevToolUses;
            const currentTool = progress.lastToolName ?? sa.lastToolName;
            const newToolCountMap = (delta > 0 && currentTool)
              ? { ...(sa.toolCountMap ?? {}), [currentTool]: ((sa.toolCountMap ?? {})[currentTool] ?? 0) + delta }
              : sa.toolCountMap;
            return {
              ...sa,
              totalTokens: progress.totalTokens ?? sa.totalTokens,
              inputTokens: progress.inputTokens ?? sa.inputTokens,
              outputTokens: progress.outputTokens ?? sa.outputTokens,
              cacheReadTokens: progress.cacheReadTokens ?? sa.cacheReadTokens,
              cacheCreationTokens: progress.cacheCreationTokens ?? sa.cacheCreationTokens,
              toolUses: newToolUses,
              durationMs: progress.durationMs ?? sa.durationMs,
              lastToolName: newToolName,
              progressSummary: progress.summary ?? sa.progressSummary,
              toolHistory: toolChanged
                ? [...(sa.toolHistory ?? []), { toolName: newToolName!, timestamp: Date.now() }]
                : sa.toolHistory,
              toolCountMap: newToolCountMap,
            };
          }),
        },
      },
    });
  },

  completeCachedSubagentTask: (conversationId: string, taskId: string | undefined, notification, agentId?: string) => {
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    if (!existing) return;
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: {
          ...existing,
          subagents: existing.subagents.map((sa) =>
            ((taskId && sa.taskId === taskId) || (!taskId && agentId && sa.agentId === agentId))
              ? {
                  ...sa,
                  finalStatus: notification.status,
                  finalSummary: notification.summary,
                  finalResult: notification.result ?? sa.finalResult,
                  totalTokens: notification.totalTokens ?? sa.totalTokens,
                  inputTokens: notification.inputTokens ?? sa.inputTokens,
                  outputTokens: notification.outputTokens ?? sa.outputTokens,
                  cacheReadTokens: notification.cacheReadTokens ?? sa.cacheReadTokens,
                  cacheCreationTokens: notification.cacheCreationTokens ?? sa.cacheCreationTokens,
                  toolUses: notification.toolUses ?? sa.toolUses,
                  durationMs: notification.durationMs ?? sa.durationMs,
                }
              : sa,
          ),
        },
      },
    });
  },

  finalizeCachedAgentTurn: (conversationId: string) => {
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    if (!existing) return;
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: {
          ...existing,
          subagents: existing.subagents.map((sa) =>
            sa.status === "active"
              ? { ...sa, status: "stopped" as const, thinkingActive: false, textActive: false }
              : { ...sa, thinkingActive: false, textActive: false },
          ),
        },
      },
    });
  },

  appendSubagentTextDelta: (sessionId, delta) =>
    set((state) => {
      if (!sessionId || !delta) return state;
      const idx = state.subagents.findIndex((sa) => sa.sessionId === sessionId);
      if (idx < 0) return state;
      const target = state.subagents[idx];
      const next: SubagentInfo = {
        ...target,
        accumulatedText: (target.accumulatedText ?? "") + delta,
        textActive: true,
      };
      const subagents = [...state.subagents];
      subagents[idx] = next;
      return { subagents };
    }),

  appendSubagentThinkingDelta: (sessionId, delta, startNewBlock) =>
    set((state) => {
      if (!sessionId || !delta) return state;
      const idx = state.subagents.findIndex((sa) => sa.sessionId === sessionId);
      if (idx < 0) return state;
      const target = state.subagents[idx];
      const prev = target.accumulatedThinking ?? "";
      const sep = startNewBlock && prev.length > 0 ? "\n\n" : "";
      const now = Date.now();
      const next: SubagentInfo = {
        ...target,
        accumulatedThinking: prev + sep + delta,
        thinkingActive: true,
        thinkingStartedAt: target.thinkingStartedAt ?? now,
        thinkingLastDeltaAt: now,
      };
      const subagents = [...state.subagents];
      subagents[idx] = next;
      return { subagents };
    }),

  appendCachedSubagentTextDelta: (conversationId, sessionId, delta) => {
    if (!sessionId || !delta) return;
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    if (!existing) return;
    const idx = existing.subagents.findIndex((sa) => sa.sessionId === sessionId);
    if (idx < 0) return;
    const target = existing.subagents[idx];
    const next: SubagentInfo = {
      ...target,
      accumulatedText: (target.accumulatedText ?? "") + delta,
      textActive: true,
    };
    const subagents = [...existing.subagents];
    subagents[idx] = next;
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: { ...existing, subagents },
      },
    });
  },

  appendCachedSubagentThinkingDelta: (conversationId, sessionId, delta, startNewBlock) => {
    if (!sessionId || !delta) return;
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    if (!existing) return;
    const idx = existing.subagents.findIndex((sa) => sa.sessionId === sessionId);
    if (idx < 0) return;
    const target = existing.subagents[idx];
    const prev = target.accumulatedThinking ?? "";
    const sep = startNewBlock && prev.length > 0 ? "\n\n" : "";
    const now = Date.now();
    const next: SubagentInfo = {
      ...target,
      accumulatedThinking: prev + sep + delta,
      thinkingActive: true,
      thinkingStartedAt: target.thinkingStartedAt ?? now,
      thinkingLastDeltaAt: now,
    };
    const subagents = [...existing.subagents];
    subagents[idx] = next;
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: { ...existing, subagents },
      },
    });
  },

  completeCachedPendingTodos: (conversationId: string) => {
    const cache = get()._agentStatusCache;
    const existing = cache[conversationId];
    if (!existing) return;
    const hasIncomplete = existing.todos.some((t) => t.status !== "completed");
    if (!hasIncomplete) return;
    set({
      _agentStatusCache: {
        ...cache,
        [conversationId]: {
          ...existing,
          todos: existing.todos.map((t) =>
            t.status === "pending" || t.status === "in_progress"
              ? { ...t, status: "completed" as const }
              : t,
          ),
        },
      },
    });
  },

  popCachedAgentStatus: (conversationId: string) => {
    const cache = get()._agentStatusCache;
    const snapshot = cache[conversationId];
    if (snapshot) {
      const { [conversationId]: _, ...restCache } = cache;
      set({ _agentStatusCache: restCache });
    }
    return snapshot;
  },

  resetLiveStatus: (status) => set({
    lastUsage: status.lastUsage,
    subagents: status.subagents,
    todos: status.todos,
    streamUsage: status.streamUsage ?? null,
    lastStreamUsage: status.lastStreamUsage ?? null,
    contextUsage: status.contextUsage ?? null,
    lastTurnDurationMs: status.lastTurnDurationMs ?? null,
  }),

}));

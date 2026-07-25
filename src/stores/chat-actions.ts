import { invoke } from "@tauri-apps/api/core";
import type { AgentRole } from "@/types";
import { useToastStore } from "./toast-store";
import { useStreamStateStore } from "./stream-state-store";
import { useAgentStatusStore } from "./agent-status-store";
import { useConversationStore } from "./conversation-store";
import { parseDbTodos, dbUsageToContextUsageData, dbUsageToUsageData } from "@/lib/db-converters";
import { resolveToolCallFinalStatus } from "@/lib/tool-result-status";
import type {
  ChatMessage,
  ChatState,
  DbMessage,
  DbMessagePage,
  MemoryContext,
  ThinkingEntry,
  ToolCall,
  ToolDisplayMeta,
  TodoItem,
  TurnUsageData,
  UsageData,
} from "./chat-types";
import { PAGE_SIZE } from "./chat-types";

/** Check whether a different conversation has become active since
 *  this loadMessages call started.  When true the caller should
 *  bail out to avoid overwriting live state with stale data. */
function isStaleLoad(conversationId: string): boolean {
  return useConversationStore.getState().activeConversationId !== conversationId;
}

// ---------------------------------------------------------------------------
// Zustand helpers (injected by the store at creation time)
// ---------------------------------------------------------------------------

type GetState = () => ChatState;
type SetState = (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void;

// ---------------------------------------------------------------------------
// DB row conversion
// ---------------------------------------------------------------------------

/** Convert a DB message row to a ChatMessage. */
export function dbMessageToChatMessage(m: DbMessage): ChatMessage {
  let toolCalls: ReadonlyArray<ToolCall> | undefined;
  if (m.tool_calls) {
    try {
      toolCalls = JSON.parse(m.tool_calls) as ToolCall[];
    } catch {
      // Ignore malformed tool_calls JSON
    }
  }
  const inputTokens = m.turn_input_tokens ?? 0;
  const outputTokens = m.turn_output_tokens ?? 0;
  const cacheReadTokens = m.turn_cache_read_tokens ?? 0;
  const cacheCreationTokens = m.turn_cache_creation_tokens ?? 0;
  const totalTokens =
    m.turn_total_tokens ?? inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  const durationMs = m.turn_duration_ms ?? 0;
  const turnUsage: TurnUsageData | undefined =
    totalTokens > 0 || durationMs > 0
      ? {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          totalTokens,
          durationMs,
        }
      : undefined;
  return {
    id: m.id,
    role: m.role as AgentRole,
    content: m.content,
    agent: m.agent ?? undefined,
    timestamp: new Date(m.created_at).getTime(),
    toolCalls,
    ...(turnUsage ? { turnUsage } : {}),
  };
}

// ---------------------------------------------------------------------------
// Message index helpers — O(1) lookup for mapMessages
// ---------------------------------------------------------------------------

/**
 * Rebuild the full message index from live messages and all snapshots.
 * Used as a safety net on load boundaries to correct any drift.
 */
function rebuildMessageIndex(
  messages: ReadonlyArray<ChatMessage>,
  snapshots: Record<string, { readonly messages: ReadonlyArray<ChatMessage> }>,
): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const m of messages) {
    index.set(m.id, null);
  }
  for (const [convId, snap] of Object.entries(snapshots)) {
    for (const m of snap.messages) {
      index.set(m.id, convId);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// mapMessages helper -- updates a message wherever it lives (live or snapshot)
// ---------------------------------------------------------------------------

/**
 * Apply a message-mapping function to wherever the target message lives --
 * either the live `messages` array or inside a snapshot.
 * Uses _messageIndex for O(1) lookup instead of O(m×n) scanning.
 */
export function createMapMessages(get: GetState, set: SetState) {
  return function mapMessages(
    msgId: string,
    mapper: (msgs: ReadonlyArray<ChatMessage>) => ReadonlyArray<ChatMessage>,
  ): void {
    const state = get();
    const location = state._messageIndex.get(msgId);

    if (location === undefined) return;

    if (location === null) {
      set({ messages: mapper(state.messages) });
    } else {
      const snap = state._snapshots[location];
      if (!snap) return;
      set({
        _snapshots: {
          ...state._snapshots,
          [location]: { ...snap, messages: mapper(snap.messages) },
        },
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Synchronous message mutation actions
// ---------------------------------------------------------------------------

export function createMessageActions(
  get: GetState,
  set: SetState,
  mapMessages: ReturnType<typeof createMapMessages>,
) {
  return {
    addMessage: (message: ChatMessage) =>
      set((state) => {
        const newIndex = new Map(state._messageIndex);
        newIndex.set(message.id, null);
        return {
          messages: [...state.messages, message],
          totalMessageCount: state.totalMessageCount + 1,
          _messageIndex: newIndex,
        };
      }),

    updateMessageContent: (id: string, content: string) =>
      mapMessages(id, (msgs) => msgs.map((msg) => (msg.id === id ? { ...msg, content } : msg))),

    updateMessageThinkingBlocks: (id: string, blocks: ReadonlyArray<ThinkingEntry>) =>
      mapMessages(id, (msgs) =>
        msgs.map((msg) => (msg.id === id ? { ...msg, thinkingBlocks: blocks } : msg)),
      ),

    updateMessageCompleteState: (
      id: string,
      content: string,
      thinkingBlocks: ReadonlyArray<ThinkingEntry> | undefined,
    ) =>
      mapMessages(id, (msgs) =>
        msgs.map((msg) =>
          msg.id === id
            ? { ...msg, content, ...(thinkingBlocks !== undefined ? { thinkingBlocks } : {}) }
            : msg,
        ),
      ),

    updateMessageTurnUsage: (id: string, turnUsage: TurnUsageData) =>
      mapMessages(id, (msgs) => msgs.map((msg) => (msg.id === id ? { ...msg, turnUsage } : msg))),

    /** Mark the most recent unconsumed mid-stream user message as consumed. */
    markMidStreamConsumed: (conversationId?: string | null) =>
      set((state) => {
        const markLatest = (messages: ReadonlyArray<ChatMessage>) => {
          const idx = [...messages].reverse().findIndex((m) => m.midStream && !m.midStreamConsumed);
          if (idx === -1) return null;
          const realIdx = messages.length - 1 - idx;
          return messages.map((msg, i) =>
            i === realIdx ? { ...msg, midStreamConsumed: true } : msg,
          );
        };

        const activeConversationId = useConversationStore.getState().activeConversationId;
        if (conversationId && conversationId !== activeConversationId) {
          const snap = state._snapshots[conversationId];
          if (!snap) return {};
          const messages = markLatest(snap.messages);
          if (!messages) return {};
          return {
            _snapshots: {
              ...state._snapshots,
              [conversationId]: { ...snap, messages },
            },
          };
        }

        const messages = markLatest(state.messages);
        return messages ? { messages } : {};
      }),

    addToolCall: (
      messageId: string,
      toolCall: { id: string; toolName: string; toolInput: string },
    ) =>
      mapMessages(messageId, (msgs) =>
        msgs.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                toolCalls: [
                  ...(msg.toolCalls ?? []),
                  { ...toolCall, status: "running" as const, textOffset: msg.content.length },
                ],
              }
            : msg,
        ),
      ),

    appendToolCallOutput: (messageId: string, toolCallId: string, output: string) =>
      mapMessages(messageId, (msgs) =>
        msgs.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                toolCalls: (msg.toolCalls ?? []).map((tc) =>
                  tc.id === toolCallId
                    ? {
                        ...tc,
                        result: `${tc.result ?? ""}${output}`,
                      }
                    : tc,
                ),
              }
            : msg,
        ),
      ),

    updateToolCallResult: (
      messageId: string,
      toolCallId: string,
      result: string,
      success: boolean,
      toolInput?: string,
      display?: ToolDisplayMeta,
    ) =>
      mapMessages(messageId, (msgs) =>
        msgs.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                toolCalls: (msg.toolCalls ?? []).map((tc) =>
                  tc.id === toolCallId
                    ? {
                        ...tc,
                        status: resolveToolCallFinalStatus(display, success),
                        result,
                        ...(display !== undefined ? { display } : {}),
                        ...(toolInput !== undefined ? { toolInput } : {}),
                      }
                    : tc,
                ),
              }
            : msg,
        ),
      ),

    updateToolCallResultById: (
      toolCallId: string,
      result: string,
      success: boolean,
      toolInput?: string,
      display?: ToolDisplayMeta,
    ) => {
      const state = get();
      const allMessages = [
        ...state.messages,
        ...Object.values(state._snapshots).flatMap((s) => s.messages),
      ];
      const targetMsg = allMessages.find((m) => m.toolCalls?.some((tc) => tc.id === toolCallId));
      if (!targetMsg) return;

      mapMessages(targetMsg.id, (msgs) =>
        msgs.map((msg) => {
          const hasToolCall = msg.toolCalls?.some((tc) => tc.id === toolCallId);
          if (!hasToolCall) return msg;

          return {
            ...msg,
            toolCalls: (msg.toolCalls ?? []).map((tc) =>
              tc.id === toolCallId
                ? {
                    ...tc,
                    status: resolveToolCallFinalStatus(display, success),
                    result,
                    ...(display !== undefined ? { display } : {}),
                    ...(toolInput !== undefined ? { toolInput } : {}),
                  }
                : tc,
            ),
          };
        }),
      );
    },

    setToolCallPendingConfirmation: (
      messageId: string,
      toolCallId: string,
      confirmId: string,
      toolName: string,
      toolInput: string,
    ) => {
      const state = get();
      // Use index to find message location, then look up the actual message
      const location = state._messageIndex.get(messageId);
      let targetMsg: ChatMessage | undefined;
      if (location === null) {
        targetMsg = state.messages.find((m) => m.id === messageId);
      } else if (location !== undefined) {
        const snap = state._snapshots[location];
        targetMsg = snap?.messages.find((m) => m.id === messageId);
      }

      const existingTc = targetMsg?.toolCalls?.find((tc) => tc.id === toolCallId);
      if (existingTc) {
        mapMessages(messageId, (msgs) =>
          msgs.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  toolCalls: (m.toolCalls ?? []).map((tc) =>
                    tc.id === toolCallId
                      ? { ...tc, status: "pending_confirmation" as const, confirmId }
                      : tc,
                  ),
                }
              : m,
          ),
        );
      } else {
        mapMessages(messageId, (msgs) =>
          msgs.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  toolCalls: [
                    ...(m.toolCalls ?? []),
                    {
                      id: toolCallId,
                      toolName,
                      toolInput,
                      status: "pending_confirmation" as const,
                      confirmId,
                      textOffset: m.content.length,
                    },
                  ],
                }
              : m,
          ),
        );
      }
    },

    resolveToolCallConfirmation: (toolCallId: string, approved: boolean) => {
      const state = get();
      // Find which message has this tool call — still needs linear scan by toolCallId
      // but now only within the correct location (not across all snapshots)
      const allMessages = [
        ...state.messages,
        ...Object.values(state._snapshots).flatMap((s) => s.messages),
      ];
      const targetMsg = allMessages.find((m) => m.toolCalls?.some((tc) => tc.id === toolCallId));
      if (!targetMsg) return;

      mapMessages(targetMsg.id, (msgs) =>
        msgs.map((msg) => {
          const tc = msg.toolCalls?.find((t) => t.id === toolCallId);
          if (!tc) return msg;
          return {
            ...msg,
            toolCalls: (msg.toolCalls ?? []).map((t) =>
              t.id === toolCallId
                ? {
                    ...t,
                    status: approved ? ("running" as const) : ("denied" as const),
                    result: approved ? undefined : "User denied tool execution",
                  }
                : t,
            ),
          };
        }),
      );
    },

    revertToolCallToPending: (toolCallId: string) => {
      const state = get();
      const allMessages = [
        ...state.messages,
        ...Object.values(state._snapshots).flatMap((s) => s.messages),
      ];
      const targetMsg = allMessages.find((m) => m.toolCalls?.some((tc) => tc.id === toolCallId));
      if (!targetMsg) return;

      mapMessages(targetMsg.id, (msgs) =>
        msgs.map((msg) => ({
          ...msg,
          toolCalls: (msg.toolCalls ?? []).map((t) =>
            // Only revertible while the original confirmId is still around;
            // findPendingConfirmation requires it to re-surface the dialog.
            t.id === toolCallId && t.confirmId
              ? { ...t, status: "pending_confirmation" as const, result: undefined }
              : t,
          ),
        })),
      );
    },

    setTurnDiff: (messageId: string, diff: string) =>
      mapMessages(messageId, (msgs) =>
        msgs.map((msg) => (msg.id === messageId ? { ...msg, turnDiff: diff } : msg)),
      ),

    revertSingleFile: async (
      messageId: string,
      filePath: string,
      fileKind: "M" | "A" | "D",
      fileDiff: string,
    ) => {
      const { useWorkspaceStore } = await import("./workspace-store");
      const workspace = useWorkspaceStore.getState().activeWorkspace;
      const workspacePath = workspace?.path;
      if (!workspacePath) {
        return { success: false, error: "No active workspace" };
      }

      try {
        const result = await invoke<{
          success: boolean;
          file_path: string;
          error: string | null;
        }>("revert_file_from_diff", {
          path: workspacePath,
          filePath,
          fileDiff,
          fileKind,
        });

        if (result.success) {
          // Update turnDiff in store by removing the reverted file's section
          const { removeFileFromDiff } = await import("@/lib/diff-utils");
          const state = get();
          const msg = state.messages.find((m) => m.id === messageId);
          if (msg?.turnDiff) {
            const updated = removeFileFromDiff(msg.turnDiff, filePath);
            get().setTurnDiff(messageId, updated);
          }

          // Refresh git status
          try {
            const { useGitStore } = await import("./git-store");
            await useGitStore.getState().refreshGitInfo(workspacePath);
          } catch {
            // non-critical
          }

          return { success: true };
        }

        return { success: false, error: result.error ?? "Unknown error" };
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        return { success: false, error };
      }
    },

    revertToolCallEdit: async (toolCallId: string) => {
      const state = get();
      const allMessages = [
        ...state.messages,
        ...Object.values(state._snapshots).flatMap((s) => s.messages),
      ];
      const targetMsg = allMessages.find((m) => m.toolCalls?.some((tc) => tc.id === toolCallId));
      const tc = targetMsg?.toolCalls?.find((t) => t.id === toolCallId);
      if (!targetMsg || !tc) {
        return { success: false, error: "Tool call not found" };
      }

      // Recover what to undo from the tool's own recorded input.
      let filePath = "";
      let oldString = "";
      let newString = "";
      try {
        const input = JSON.parse(tc.toolInput) as Record<string, unknown>;
        filePath = (input.file_path as string) ?? (input.path as string) ?? "";
        oldString = (input.old_string as string) ?? "";
        newString = (input.new_string as string) ?? "";
      } catch {
        return { success: false, error: "Invalid tool input" };
      }
      if (!filePath) {
        return { success: false, error: "No file path" };
      }

      const isWrite = tc.toolName === "Write" || tc.toolName === "write_file";

      try {
        const result = await invoke<{ success: boolean; error: string | null }>(
          "revert_tool_edit",
          { filePath, oldString, newString, isWrite },
        );

        if (result.success) {
          mapMessages(targetMsg.id, (msgs) =>
            msgs.map((msg) =>
              msg.toolCalls?.some((t) => t.id === toolCallId)
                ? {
                    ...msg,
                    toolCalls: (msg.toolCalls ?? []).map((t) =>
                      t.id === toolCallId ? { ...t, reverted: true } : t,
                    ),
                  }
                : msg,
            ),
          );
          return { success: true };
        }

        return { success: false, error: result.error ?? "Unknown error" };
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        return { success: false, error };
      }
    },

    addMessageMedia: (messageId: string, mediaType: string, data: string) =>
      mapMessages(messageId, (msgs) =>
        msgs.map((msg) =>
          msg.id === messageId
            ? { ...msg, media: [...(msg.media ?? []), { mediaType, data }] }
            : msg,
        ),
      ),

    clearMessages: () => {
      const state = get();
      // Rebuild index keeping only snapshot entries
      const newIndex = rebuildMessageIndex([], state._snapshots);
      set({
        messages: [],
        hasMoreMessages: false,
        totalMessageCount: 0,
        _dbTotal: 0,
        isLoadingOlder: false,
        _messageIndex: newIndex,
      });
      useStreamStateStore.getState().resetStreamState();
      useAgentStatusStore.getState().resetLiveStatus({ lastUsage: null, subagents: [], todos: [] });
    },

    setActiveAgent: (agent: string) => set({ activeAgent: agent }),
  };
}

// ---------------------------------------------------------------------------
// Async actions (DB operations)
// ---------------------------------------------------------------------------

export function createAsyncActions(get: GetState, set: SetState) {
  return {
    loadMessages: async (conversationId: string) => {
      const agentStatusStore = useAgentStatusStore.getState();
      // Restore cached agent status if available, then remove from cache
      const agentCache = agentStatusStore.popCachedAgentStatus(conversationId);
      const cachedSubagents = agentCache?.subagents ?? [];
      const cachedUsage = agentCache?.lastUsage ?? null;
      const cachedStreamUsage = agentCache?.streamUsage ?? null;
      const cachedLastStreamUsage = agentCache?.lastStreamUsage ?? null;
      const cachedContextUsage = agentCache?.contextUsage ?? null;
      const cachedLastTurnDurationMs = agentCache?.lastTurnDurationMs ?? null;

      // -- IMPORTANT: Check snapshot BEFORE any async work --
      const snapshot = get()._snapshots[conversationId];
      if (snapshot) {
        // Move snapshot data to live state synchronously, remove from cache
        const { [conversationId]: __, ...restSnapshots } = get()._snapshots;
        const newMessages = snapshot.messages;
        set({
          messages: newMessages,
          _snapshots: restSnapshots,
          hasMoreMessages: false,
          totalMessageCount: newMessages.length,
          _dbTotal: 0,
          isLoadingOlder: false,
          _messageIndex: rebuildMessageIndex(newMessages, restSnapshots),
        });
        useStreamStateStore.getState().restoreStreamState({
          isStreaming: snapshot.isStreaming,
          streamingMessageId: snapshot.streamingMessageId,
          streamingConversationId: snapshot.streamingConversationId,
          streamStartTime: snapshot.streamStartTime,
          streamPhase: snapshot.streamPhase,
        });
        useAgentStatusStore.getState().resetLiveStatus({
          todos: agentCache?.todos ?? [],
          subagents: cachedSubagents,
          lastUsage: cachedUsage,
          streamUsage: cachedStreamUsage,
          lastStreamUsage: cachedLastStreamUsage,
          contextUsage: cachedContextUsage,
          lastTurnDurationMs: cachedLastTurnDurationMs,
        });

        // Now do async DB fetches for todos/usage that weren't in cache.
        // Guard against stale loads — if the user switched away during await,
        // we must not overwrite live state with data from this conversation.
        if ((agentCache?.todos ?? []).length === 0 && !isStaleLoad(conversationId)) {
          try {
            const dbTodos = await invoke<
              ReadonlyArray<{ content: string; status: string; active_form: string }>
            >("get_conversation_todos", { conversationId });
            if (dbTodos.length > 0 && !isStaleLoad(conversationId)) {
              useAgentStatusStore.getState().setTodos(parseDbTodos(dbTodos));
            }
          } catch {
            // Non-critical: persisted todos are optional
          }
        }
        if (!cachedUsage && !isStaleLoad(conversationId)) {
          try {
            const dbUsage = await invoke<{
              input_tokens: number;
              output_tokens: number;
              cache_read_tokens: number;
              cache_creation_tokens: number;
              total_cost_usd: number;
              context_window: number;
              model: string;
              total_duration_ms: number;
              context_total_tokens?: number;
              context_max_tokens?: number;
              context_percentage?: number;
              context_usage_updated_at?: number;
              context_breakdown_json?: string | null;
            } | null>("get_conversation_usage", { conversationId });
            if (dbUsage && !isStaleLoad(conversationId)) {
              useAgentStatusStore.getState().resetLiveStatus({
                lastUsage: dbUsageToUsageData(dbUsage),
                subagents: useAgentStatusStore.getState().subagents,
                todos: useAgentStatusStore.getState().todos,
                streamUsage: useAgentStatusStore.getState().streamUsage,
                lastStreamUsage: useAgentStatusStore.getState().lastStreamUsage,
                contextUsage:
                  dbUsageToContextUsageData(dbUsage) ?? useAgentStatusStore.getState().contextUsage,
                lastTurnDurationMs: useAgentStatusStore.getState().lastTurnDurationMs,
              });
            }
          } catch {
            // Non-critical: persisted usage is optional
          }
        }
        return;
      }

      // -- No snapshot: load from DB --
      let todosToRestore: ReadonlyArray<TodoItem> = agentCache?.todos ?? [];
      if (todosToRestore.length === 0) {
        try {
          const dbTodos = await invoke<
            ReadonlyArray<{ content: string; status: string; active_form: string }>
          >("get_conversation_todos", { conversationId });
          if (dbTodos.length > 0) {
            todosToRestore = parseDbTodos(dbTodos);
          }
        } catch {
          // Non-critical: persisted todos are optional
        }
      }

      let usageToRestore: UsageData | null = cachedUsage;
      let contextUsageToRestore = cachedContextUsage;
      if (!usageToRestore) {
        try {
          const dbUsage = await invoke<{
            input_tokens: number;
            output_tokens: number;
            cache_read_tokens: number;
            cache_creation_tokens: number;
            total_cost_usd: number;
            context_window: number;
            model: string;
            total_duration_ms: number;
            context_total_tokens?: number;
            context_max_tokens?: number;
            context_percentage?: number;
            context_usage_updated_at?: number;
            context_breakdown_json?: string | null;
          } | null>("get_conversation_usage", { conversationId });
          if (dbUsage) {
            usageToRestore = dbUsageToUsageData(dbUsage);
            contextUsageToRestore = dbUsageToContextUsageData(dbUsage) ?? contextUsageToRestore;
          }
        } catch {
          // Non-critical: persisted usage is optional
        }
      }

      // After all async DB fetches, bail out if the user already switched
      // to a different conversation — prevents overwriting live state with
      // stale data from this conversation.
      if (isStaleLoad(conversationId)) {
        return;
      }

      try {
        const page = await invoke<DbMessagePage>("get_latest_messages", {
          conversationId,
          limit: PAGE_SIZE,
        });

        if (page.messages.length === 0) {
          console.warn("[loadMessages] No persisted messages were returned");
        }

        // Final staleness check after the last await
        if (isStaleLoad(conversationId)) {
          return;
        }

        const messages: ChatMessage[] = page.messages.map(dbMessageToChatMessage);
        const hasMore = messages.length < page.total;
        const currentSnapshots = get()._snapshots;

        set({
          messages,
          hasMoreMessages: hasMore,
          totalMessageCount: page.total,
          _dbTotal: page.total,
          isLoadingOlder: false,
          _messageIndex: rebuildMessageIndex(messages, currentSnapshots),
        });
        useStreamStateStore.getState().resetStreamState();
        useAgentStatusStore.getState().resetLiveStatus({
          lastUsage: usageToRestore,
          subagents: cachedSubagents,
          todos: todosToRestore,
          streamUsage: cachedStreamUsage,
          lastStreamUsage: cachedLastStreamUsage,
          contextUsage: contextUsageToRestore,
          lastTurnDurationMs: cachedLastTurnDurationMs,
        });
      } catch {
        console.error("[chat-store] messages failed to load");
        if (isStaleLoad(conversationId)) return;
        const currentSnapshots = get()._snapshots;
        set({
          messages: [],
          hasMoreMessages: false,
          totalMessageCount: 0,
          _dbTotal: 0,
          isLoadingOlder: false,
          _messageIndex: rebuildMessageIndex([], currentSnapshots),
        });
        useStreamStateStore.getState().resetStreamState();
        useAgentStatusStore
          .getState()
          .resetLiveStatus({ lastUsage: null, subagents: [], todos: [] });
        useToastStore.getState().addToast("error", "Failed to load messages. Please retry.");
      }
    },

    loadOlderMessages: async (conversationId: string) => {
      const preState = get();
      if (preState.isLoadingOlder || !preState.hasMoreMessages) {
        return;
      }

      set({ isLoadingOlder: true });

      try {
        let dbTotal = preState._dbTotal;
        const dbLoadedCount = Math.min(preState.messages.length, dbTotal);
        let remaining = dbTotal - dbLoadedCount;

        // If _dbTotal appears stale (no remaining but DB might have more),
        // do a fresh count to correct pagination drift after streaming/compaction.
        if (remaining <= 0) {
          try {
            const freshCount = await invoke<number>("get_message_count", { conversationId });
            if (freshCount > preState.messages.length) {
              dbTotal = freshCount;
              remaining = freshCount - preState.messages.length;
              set({ _dbTotal: freshCount, hasMoreMessages: true });
            } else {
              set({ hasMoreMessages: false, isLoadingOlder: false });
              return;
            }
          } catch {
            console.error("[chat-store] message count refresh failed");
            set({ hasMoreMessages: false, isLoadingOlder: false });
            return;
          }
        }

        const nextLimit = Math.min(PAGE_SIZE, remaining);
        const nextOffset = Math.max(0, remaining - nextLimit);

        const page = await invoke<DbMessagePage>("get_conversation_messages", {
          conversationId,
          limit: nextLimit,
          offset: nextOffset,
        });

        // Correct _dbTotal from the authoritative page.total if it drifted
        if (page.total !== dbTotal) {
          dbTotal = page.total;
        }

        const olderMessages: ChatMessage[] = page.messages.map(dbMessageToChatMessage);

        const current = get();
        const existingIds = new Set(current.messages.map((m) => m.id));
        const uniqueOlder = olderMessages.filter((m) => !existingIds.has(m.id));

        if (uniqueOlder.length > 0) {
          const newIndex = new Map(current._messageIndex);
          for (const m of uniqueOlder) {
            newIndex.set(m.id, null);
          }
          set({
            messages: [...uniqueOlder, ...current.messages],
            hasMoreMessages: nextOffset > 0,
            isLoadingOlder: false,
            _dbTotal: dbTotal,
            _messageIndex: newIndex,
          });
        } else {
          set({ hasMoreMessages: nextOffset > 0, isLoadingOlder: false, _dbTotal: dbTotal });
        }
      } catch {
        set({ isLoadingOlder: false });
        useToastStore
          .getState()
          .addToast("warning", "Failed to load older messages. Please retry.");
      }
    },

    persistMessage: async (conversationId: string, msg: ChatMessage) => {
      try {
        const toolCallsJson =
          msg.toolCalls && msg.toolCalls.length > 0 ? JSON.stringify(msg.toolCalls) : null;
        await invoke("save_message", {
          conversationId,
          id: msg.id,
          role: msg.role,
          content: msg.content,
          agent: msg.agent ?? null,
          toolCalls: toolCallsJson,
          turnUsage: msg.turnUsage
            ? {
                input_tokens: msg.turnUsage.inputTokens,
                output_tokens: msg.turnUsage.outputTokens,
                cache_read_tokens: msg.turnUsage.cacheReadTokens,
                cache_creation_tokens: msg.turnUsage.cacheCreationTokens,
                total_tokens: msg.turnUsage.totalTokens,
                duration_ms: msg.turnUsage.durationMs,
              }
            : null,
        });
      } catch {
        useToastStore
          .getState()
          .addToast("warning", "Message was not saved to disk. Please retry.");
      }
    },

    fetchMemoryContext: async (conversationId: string, userMessage: string) => {
      try {
        const ctx = await invoke<MemoryContext>("get_memory_context", {
          conversationId,
          userMessage,
        });
        return ctx.has_context ? ctx.system_prompt : "";
      } catch {
        // Non-critical: memory context is optional enhancement
        return "";
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot actions
// ---------------------------------------------------------------------------

export function createSnapshotActions(get: GetState, set: SetState) {
  return {
    saveSnapshot: (conversationId: string) => {
      const {
        messages,
        hasMoreMessages,
        totalMessageCount,
        _dbTotal,
        isLoadingOlder,
        _messageIndex,
      } = get();
      const {
        isStreaming,
        streamingMessageId,
        streamingConversationId,
        streamStartTime,
        streamPhase,
      } = useStreamStateStore.getState();
      const snapshotIsStreaming = isStreaming && streamingConversationId === conversationId;
      // Remap live message IDs to the snapshot's conversationId in the index
      const newIndex = new Map(_messageIndex);
      for (const m of messages) {
        newIndex.set(m.id, conversationId);
      }
      set({
        _snapshots: {
          ...get()._snapshots,
          [conversationId]: {
            messages,
            hasMoreMessages,
            totalMessageCount,
            dbTotal: _dbTotal,
            isLoadingOlder,
            isStreaming: snapshotIsStreaming,
            streamingMessageId: snapshotIsStreaming ? streamingMessageId : null,
            streamingConversationId: snapshotIsStreaming ? streamingConversationId : null,
            streamStartTime: snapshotIsStreaming ? streamStartTime : null,
            streamPhase: snapshotIsStreaming ? streamPhase : null,
          },
        },
        _messageIndex: newIndex,
      });
    },

    clearSnapshot: (conversationId: string) => {
      const state = get();
      const snap = state._snapshots[conversationId];
      const { [conversationId]: _, ...rest } = state._snapshots;
      // Remove snapshot message entries from the index
      const newIndex = new Map(state._messageIndex);
      if (snap) {
        for (const m of snap.messages) {
          newIndex.delete(m.id);
        }
      }
      set({ _snapshots: rest, _messageIndex: newIndex });
    },

    addMessageToSnapshot: (conversationId: string, message: ChatMessage) => {
      const state = get();
      const snap = state._snapshots[conversationId];
      if (!snap) return;

      const newIndex = new Map(state._messageIndex);
      newIndex.set(message.id, conversationId);

      set({
        _snapshots: {
          ...state._snapshots,
          [conversationId]: {
            ...snap,
            messages: [...snap.messages, message],
            totalMessageCount: snap.totalMessageCount + 1,
          },
        },
        _messageIndex: newIndex,
      });
    },

    ensureSnapshotLoaded: async (conversationId: string) => {
      const state = get();
      const activeConversationId = useConversationStore.getState().activeConversationId;
      if (!conversationId || conversationId === activeConversationId) {
        return;
      }

      const existing = state._snapshots[conversationId];
      if (existing) {
        return;
      }

      try {
        const page = await invoke<DbMessagePage>("get_latest_messages", {
          conversationId,
          limit: PAGE_SIZE,
        });
        if (useConversationStore.getState().activeConversationId === conversationId) {
          return;
        }

        const messages: ChatMessage[] = page.messages.map(dbMessageToChatMessage);
        const prev = get();
        if (prev._snapshots[conversationId]) {
          return;
        }
        const nextSnapshots = {
          ...prev._snapshots,
          [conversationId]: {
            messages,
            hasMoreMessages: messages.length < page.total,
            totalMessageCount: page.total,
            dbTotal: page.total,
            isLoadingOlder: false,
            isStreaming: false,
            streamingMessageId: null,
            streamingConversationId: null,
            streamStartTime: null,
            streamPhase: null,
          },
        };
        set({
          _snapshots: nextSnapshots,
          _messageIndex: rebuildMessageIndex(prev.messages, nextSnapshots),
        });

        const cachedUsage =
          useAgentStatusStore.getState()._agentStatusCache[conversationId]?.lastUsage;
        if (!cachedUsage) {
          try {
            const dbUsage = await invoke<{
              input_tokens: number;
              output_tokens: number;
              cache_read_tokens: number;
              cache_creation_tokens: number;
              total_cost_usd: number;
              context_window: number;
              model: string;
              total_duration_ms: number;
              context_total_tokens?: number;
              context_max_tokens?: number;
              context_percentage?: number;
              context_usage_updated_at?: number;
              context_breakdown_json?: string | null;
            } | null>("get_conversation_usage", { conversationId });
            if (
              dbUsage &&
              useConversationStore.getState().activeConversationId !== conversationId &&
              !useAgentStatusStore.getState()._agentStatusCache[conversationId]?.lastUsage
            ) {
              useAgentStatusStore
                .getState()
                .setCachedUsage(conversationId, dbUsageToUsageData(dbUsage));
              const contextUsage = dbUsageToContextUsageData(dbUsage);
              if (contextUsage) {
                useAgentStatusStore.getState().setCachedContextUsage(conversationId, contextUsage);
              }
            }
          } catch {
            // Non-critical: persisted usage is optional
          }
        }
      } catch {
        console.warn("[chat-store] snapshot failed to load");
      }
    },

    refreshDbTotal: async (conversationId: string) => {
      const activeConvId = useConversationStore.getState().activeConversationId;
      if (conversationId !== activeConvId) {
        return;
      }

      try {
        const count = await invoke<number>("get_message_count", { conversationId });
        // Guard again after the await — user may have switched conversations
        if (useConversationStore.getState().activeConversationId !== conversationId) {
          return;
        }

        const current = get();
        const hasMore = current.messages.length < count;
        set({ _dbTotal: count, hasMoreMessages: hasMore });
      } catch {
        console.warn("[chat-store] persisted message count refresh failed");
      }
    },
  };
}

import { create } from "zustand";
import type { ChatState } from "./chat-types";
import {
  createMapMessages,
  createMessageActions,
  createAsyncActions,
  createSnapshotActions,
} from "./chat-actions";

// ---------------------------------------------------------------------------
// Re-export all public types so consumers importing from "@/stores/chat-store"
// continue to work without changes.
// ---------------------------------------------------------------------------

export type {
  ToolDisplayMeta,
  ToolCall,
  ThinkingEntry,
  ChatMessage,
  CommandInvocationMeta,
  TurnUsageData,
  UsageData,
  SubagentInfo,
  ToolHistoryEntry,
  TodoItem,
  McpServerInfo,
  SlashCommandInfo,
  AskUserQuestionOption,
  AskUserQuestionItem,
  PendingAskUserQuestion,
} from "./chat-types";

// ---------------------------------------------------------------------------
// Core message store
// ---------------------------------------------------------------------------

export const useChatStore = create<ChatState>((set, get) => {
  const mapMessages = createMapMessages(get, set);
  const messageActions = createMessageActions(get, set, mapMessages);
  const asyncActions = createAsyncActions(get, set);
  const snapshotActions = createSnapshotActions(get, set);

  return {
    // Initial state
    messages: [],
    activeAgent: "claude",
    hasMoreMessages: false,
    totalMessageCount: 0,
    _dbTotal: 0,
    isLoadingOlder: false,
    _snapshots: {},
    _messageIndex: new Map(),

    // Synchronous message mutations
    ...messageActions,

    // Async DB operations
    ...asyncActions,

    // Snapshot management
    ...snapshotActions,
  };
});

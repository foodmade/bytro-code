import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useToastStore } from "./toast-store";
import { useImagegenPrefsStore } from "./imagegen-prefs-store";
import { useChatStore } from "./chat-store";
import { useSplitViewStore } from "./split-view-store";
import { formatError } from "@/lib/format-error";
import { getGlobalRegistry } from "@/lib/chat-stream-manager";
import { clearWarmSession } from "@/lib/warm-session-tracker";

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updated_at: string;
  readonly model: string;
  readonly message_count: number;
  readonly preview: string;
  readonly session_id: string | null;
  readonly workspace_id: string | null;
  readonly is_pinned: boolean;
  readonly is_archived: boolean;
  /** Parent conversation id when this is a fork; null for normal conversations. */
  readonly parent_conversation_id: string | null;
}

interface Conversation {
  readonly id: string;
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly model: string;
  readonly message_count: number;
  readonly session_id: string | null;
  readonly workspace_id: string | null;
  /** Fork lineage — all null for normal conversations. */
  readonly parent_conversation_id?: string | null;
  readonly forked_from_session_id?: string | null;
  readonly forked_from_message_id?: string | null;
}

interface ConversationState {
  readonly conversations: ReadonlyArray<ConversationSummary>;
  readonly activeConversationId: string | null;
  /** IDs of conversations whose tabs are open in the tab bar.
   *  Pinned conversations open as tabs when pinned or during initial tab setup; refreshes preserve explicit tab closes. */
  readonly openedTabIds: ReadonlyArray<string>;
  readonly isLoading: boolean;
  /** Remembered workspace filter — used by parameterless loadConversations() calls */
  readonly _workspaceFilter: string | null;
  readonly loadConversations: (workspaceId?: string) => Promise<void>;
  readonly createConversation: (model: string, workspaceId?: string, convType?: string) => Promise<Conversation>;
  /** Fork a conversation at an anchor message into a new conversation, copying
   *  history up to (and including) the anchor. The new conversation's first turn
   *  then forks a real SDK session (see use-chat-streaming pending-fork detection). */
  readonly forkConversation: (srcConversationId: string, anchorMessageId: string) => Promise<Conversation>;
  /** Pending-fork context — present only while a forked conversation hasn't taken
   *  its first turn yet (its own session_id is still null). */
  readonly getForkContext: (conversationId: string) => Promise<{ forkedFromSessionId: string; forkedFromMessageId: string | null } | null>;
  readonly switchConversation: (id: string) => void;
  /** Pull a single conversation into the in-memory list if it's not already
   *  there.  Idempotent and safe to call from render paths. */
  readonly ensureConversationLoaded: (conversationId: string) => Promise<void>;
  readonly deleteConversation: (id: string) => Promise<void>;
  /** Close a tab from the tab bar only — does NOT delete from database.
   *  Automatically switches to the nearest remaining tab. */
  readonly removeTab: (id: string) => void;
  /** Add a conversation id to the opened tabs (idempotent). */
  readonly openTab: (id: string) => void;
  /** Reorder tabs by moving a tab from one index to another. */
  readonly reorderTabs: (fromIndex: number, toIndex: number) => void;
  readonly renameConversation: (id: string, title: string) => Promise<void>;
  readonly updateConversationModel: (conversationId: string, model: string) => Promise<void>;
  readonly setActiveConversationId: (id: string | null) => void;
  readonly pinConversation: (id: string, pinned: boolean) => Promise<void>;
  readonly setConversationArchived: (id: string, archived: boolean) => Promise<void>;
  readonly updateSessionId: (conversationId: string, sessionId: string) => Promise<void>;
  readonly getSessionId: (conversationId: string) => Promise<string | null>;
  /** Optimistic in-memory update for a single conversation (avoids full loadConversations). */
  readonly updateConversationInPlace: (conversationId: string, patch: Partial<ConversationSummary>) => void;
  /** Hard reset used when switching to a different workspace context. */
  readonly resetForWorkspaceSwitch: (workspaceId: string | null) => void;
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  openedTabIds: [],
  isLoading: false,
  _workspaceFilter: null,

  loadConversations: async (workspaceId?: string) => {
    // When an explicit workspaceId is passed, remember it for future
    // parameterless calls (e.g. from chat-stream-listeners).
    // When called without arguments, reuse the stored filter.
    const effectiveId = workspaceId !== undefined ? workspaceId : (get()._workspaceFilter ?? undefined);
    const isWorkspaceSwitch = workspaceId !== undefined && workspaceId !== get()._workspaceFilter;
    if (workspaceId !== undefined) {
      set({ _workspaceFilter: workspaceId ?? null });
    }
    // Clear stale conversations immediately on workspace switch so that the
    // skeleton loading state is visible instead of showing old data.
    set({ isLoading: true, ...(isWorkspaceSwitch ? { conversations: [] } : {}) });
    try {
      const [activeConversations, archivedConversations] = await Promise.all([
        invoke<ConversationSummary[]>("list_conversations", {
          limit: 50,
          offset: 0,
          workspaceId: effectiveId ?? null,
          archived: false,
        }),
        invoke<ConversationSummary[]>("list_conversations", {
          limit: 50,
          offset: 0,
          workspaceId: effectiveId ?? null,
          archived: true,
        }),
      ]);
      const fetched = [...activeConversations, ...archivedConversations];
      const fetchedIds = new Set(fetched.map((c) => c.id));
      const activeId = get().activeConversationId;
      const existingTabs = get().openedTabIds;

      // Guard a full refresh from evicting conversations that are still open as
      // tabs (or currently active) but missing from THIS query's result set.
      // This fires when a background "new conversation" finishes and triggers
      // loadConversations() while another new conversation was created during the
      // in-flight list_conversations await — its row didn't exist when the query
      // ran, so the result lacks it — or when an open conversation falls outside
      // the workspace / LIMIT 50 window. Without this, those tabs vanish even
      // though the session is still running (multi-session tasks → tabs disappear).
      // Workspace switches clear `conversations` up front (see above), so
      // `survivors` is naturally empty there and stale cross-workspace tabs still drop.
      const tabIdSet = new Set(existingTabs);
      const survivors = get().conversations.filter(
        (c) => !fetchedIds.has(c.id) && (tabIdSet.has(c.id) || c.id === activeId),
      );
      const conversations = [...fetched, ...survivors];
      const liveIds = new Set(conversations.map((c) => c.id));

      const pinnedIds = activeConversations.filter((c) => c.is_pinned).map((c) => c.id);

      const keptTabIds = existingTabs.filter((id) => liveIds.has(id));
      const shouldInitializeTabs = keptTabIds.length === 0;
      const initialTabIds = activeId && liveIds.has(activeId) && !pinnedIds.includes(activeId)
        ? [...pinnedIds, activeId]
        : pinnedIds;
      const nextTabIds = shouldInitializeTabs
        ? initialTabIds
        : activeId && liveIds.has(activeId) && !keptTabIds.includes(activeId)
          ? [...keptTabIds, activeId]
          : keptTabIds;

      set({ conversations, openedTabIds: nextTabIds, isLoading: false });
    } catch (err: unknown) {
      set({ isLoading: false });
      useToastStore.getState().addToast(
        "error",
        `Failed to load conversations: ${formatError(err)}`,
      );
    }
  },

  createConversation: async (model: string, workspaceId?: string, convType?: string) => {
    const conversation = await invoke<Conversation>("create_conversation", {
      model,
      workspaceId: workspaceId ?? null,
      convType: convType ?? null,
    });
    const summary: ConversationSummary = {
      id: conversation.id,
      title: conversation.title,
      updated_at: conversation.updated_at,
      model: conversation.model,
      message_count: conversation.message_count,
      preview: "",
      session_id: conversation.session_id,
      workspace_id: conversation.workspace_id,
      is_pinned: false,
      is_archived: false,
      parent_conversation_id: conversation.parent_conversation_id ?? null,
    };
    set((state) => ({
      activeConversationId: conversation.id,
      conversations: [summary, ...state.conversations],
      openedTabIds: state.openedTabIds.includes(conversation.id)
        ? state.openedTabIds
        : [...state.openedTabIds, conversation.id],
    }));

    // Claude prewarm is now triggered from ChatInput when conversationId becomes null,
    // which covers all new-chat entry points (keyboard shortcut, sidebar, workspace card).

    return conversation;
  },

  forkConversation: async (srcConversationId: string, anchorMessageId: string) => {
    const conversation = await invoke<Conversation>("fork_conversation", {
      srcConversationId,
      anchorMessageId,
    });
    const summary: ConversationSummary = {
      id: conversation.id,
      title: conversation.title,
      updated_at: conversation.updated_at,
      model: conversation.model,
      message_count: conversation.message_count,
      preview: "",
      session_id: conversation.session_id,
      workspace_id: conversation.workspace_id,
      is_pinned: false,
      is_archived: false,
      parent_conversation_id: conversation.parent_conversation_id ?? null,
    };
    set((state) => ({
      activeConversationId: conversation.id,
      conversations: [summary, ...state.conversations],
      openedTabIds: state.openedTabIds.includes(conversation.id)
        ? state.openedTabIds
        : [...state.openedTabIds, conversation.id],
    }));
    return conversation;
  },

  getForkContext: async (conversationId: string) => {
    const conv = await invoke<Conversation | null>("get_conversation", { conversationId });
    // Pending fork: lineage recorded but no own session yet. Once the first turn
    // forks an SDK session, session_id is set and this returns null (normal flow).
    if (conv && !conv.session_id && conv.forked_from_session_id) {
      return {
        forkedFromSessionId: conv.forked_from_session_id,
        forkedFromMessageId: conv.forked_from_message_id ?? null,
      };
    }
    return null;
  },

  switchConversation: (id: string) => {
    set((state) => ({
      activeConversationId: id,
      openedTabIds: state.openedTabIds.includes(id)
        ? state.openedTabIds
        : [...state.openedTabIds, id],
    }));
  },

  deleteConversation: async (id: string) => {
    // Abort any in-flight stream requests tied to this conversation BEFORE the
    // DB row is gone — otherwise chat-done/persistMessage races the CASCADE
    // delete and hits a FOREIGN KEY violation (see toast "Message not saved to
    // disk"). Also drop the warm session so a killed CLI process isn't reused.
    try {
      const registry = getGlobalRegistry();
      const pendingRequestIds: string[] = [];
      registry.contexts.forEach((ctx, reqId) => {
        if (ctx.conversationId === id) pendingRequestIds.push(reqId);
      });
      await Promise.all(
        pendingRequestIds.map((rid) =>
          invoke("abort_chat", { requestId: rid }).catch(() => {
            console.error("[conversation-store] active request cancellation failed");
          }),
        ),
      );
      clearWarmSession(id);
    } catch {
      console.error("[conversation-store] pre-delete cleanup failed");
    }

    const wasActive = get().activeConversationId === id;
    await invoke("delete_conversation", { conversationId: id });
    // Drop any per-conversation imagegen overrides so they don't leak into a
    // future conversation that happens to reuse this id (defensive).
    useImagegenPrefsStore.getState().clearScope(id);
    set((state) => {
      const remainingTabs = state.openedTabIds.filter((tid) => tid !== id);
      const needSwitch = state.activeConversationId === id;
      let nextActiveId: string | null = state.activeConversationId;
      if (needSwitch) {
        // Pick the tab that was adjacent (prefer the one before, then after)
        const idx = state.openedTabIds.indexOf(id);
        nextActiveId = remainingTabs[Math.min(idx, remainingTabs.length - 1)] ?? null;
      }
      return {
        activeConversationId: nextActiveId,
        conversations: state.conversations.filter((c) => c.id !== id),
        openedTabIds: remainingTabs,
      };
    });
    // Purge every UI surface still bound to the deleted conversation. A pane
    // (or snapshot) left pointing at the deleted row makes the next send reuse
    // a conversation id with no DB row — the stream runs but nothing persists
    // and the conversation never appears in any list (ghost conversation).
    useChatStore.getState().clearSnapshot(id);
    if (wasActive) {
      useChatStore.getState().clearMessages();
    }
    useSplitViewStore.getState().purgeConversation(id, get().activeConversationId);
  },

  removeTab: (id: string) => {
    set((state) => {
      const remainingTabs = state.openedTabIds.filter((tid) => tid !== id);
      const needSwitch = state.activeConversationId === id;
      let nextActiveId: string | null = state.activeConversationId;
      if (needSwitch) {
        const idx = state.openedTabIds.indexOf(id);
        nextActiveId = remainingTabs[Math.min(idx, remainingTabs.length - 1)] ?? null;
      }
      return {
        activeConversationId: nextActiveId,
        openedTabIds: remainingTabs,
      };
    });
  },

  openTab: (id: string) => {
    set((state) => ({
      openedTabIds: state.openedTabIds.includes(id)
        ? state.openedTabIds
        : [...state.openedTabIds, id],
    }));
  },

  reorderTabs: (fromIndex: number, toIndex: number) => {
    set((state) => {
      const tabs = [...state.openedTabIds];
      if (fromIndex < 0 || fromIndex >= tabs.length || toIndex < 0 || toIndex >= tabs.length) {
        return state;
      }
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, moved);
      return { openedTabIds: tabs };
    });
  },

  renameConversation: async (id: string, title: string) => {
    await invoke("rename_conversation", { conversationId: id, title });
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title } : c,
      ),
    }));
  },

  updateConversationModel: async (conversationId: string, model: string) => {
    await invoke("update_conversation_model", { conversationId, model });
    const inList = get().conversations.some((c) => c.id === conversationId);
    if (inList) {
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, model } : c,
        ),
      }));
      return;
    }
    // The conversation isn't in the in-memory list — this happens when the
    // active pane shows a conversation that wasn't included in the most
    // recent `list_conversations` window (e.g. older conversations beyond
    // the limit, or panes restored from a different workspace).  Fetch the
    // record from Rust so subscribers (ModelSelector etc.) can resolve it.
    try {
      const fetched = await invoke<ConversationSummary | null>("get_conversation_summary", { conversationId });
      if (fetched) {
        set((state) => ({
          conversations: [...state.conversations, { ...fetched, model }],
        }));
      } else {
        console.warn("[conversation-store] conversation was not found during model update");
      }
    } catch {
      console.error("[conversation-store] conversation model update failed");
    }
  },

  setActiveConversationId: (id: string | null) => {
    set({ activeConversationId: id });
  },

  /** Ensure a conversation is present in the in-memory list — fetch from
   *  Rust if absent.  Required when split panes outlive a workspace switch
   *  and reference conversations that aren't part of the current workspace's
   *  loaded window.  Without this, downstream consumers (ModelSelector,
   *  ChatInput, …) silently fall back to global settings and appear stuck. */
  ensureConversationLoaded: async (conversationId: string) => {
    if (get().conversations.some((c) => c.id === conversationId)) return;
    try {
      const fetched = await invoke<ConversationSummary | null>("get_conversation_summary", { conversationId });
      if (!fetched) return;
      set((state) => {
        // Re-check inside the setter to avoid duplicates from concurrent calls
        if (state.conversations.some((c) => c.id === conversationId)) return state;
        return { conversations: [...state.conversations, fetched] };
      });
    } catch {
      console.error("[conversation-store] conversation failed to load");
    }
  },

  pinConversation: async (id: string, pinned: boolean) => {
    await invoke("pin_conversation", { conversationId: id, pinned });
    set((state) => {
      const updatedConversations = state.conversations.map((c) =>
        c.id === id ? { ...c, is_pinned: pinned } : c,
      );
      let updatedTabs = state.openedTabIds;
      if (pinned && !updatedTabs.includes(id)) {
        // Pinning opens a tab
        updatedTabs = [...updatedTabs, id];
      }
      // Unpinning does NOT auto-close the tab — user can close it manually
      return {
        conversations: updatedConversations,
        openedTabIds: updatedTabs,
      };
    });
  },

  setConversationArchived: async (id: string, archived: boolean) => {
    await invoke("set_conversation_archived", { conversationId: id, archived });
    set((state) => {
      const updatedConversations = state.conversations.map((c) =>
        c.id === id ? { ...c, is_archived: archived } : c,
      );
      if (!archived) {
        return { conversations: updatedConversations };
      }

      const remainingTabs = state.openedTabIds.filter((tid) => tid !== id);
      const needSwitch = state.activeConversationId === id;
      let nextActiveId: string | null = state.activeConversationId;
      if (needSwitch) {
        const idx = state.openedTabIds.indexOf(id);
        nextActiveId = remainingTabs[Math.min(idx, remainingTabs.length - 1)] ?? null;
      }
      return {
        activeConversationId: nextActiveId,
        conversations: updatedConversations,
        openedTabIds: remainingTabs,
      };
    });
  },

  updateSessionId: async (conversationId: string, sessionId: string) => {
    await invoke("update_conversation_session", { conversationId, sessionId });
  },

  getSessionId: async (conversationId: string) => {
    const conv = await invoke<Conversation | null>("get_conversation", { conversationId });
    // Use || instead of ?? so that empty strings (used as a "cleared" sentinel
    // when warm sessions are invalidated) are treated as null.
    return conv?.session_id || null;
  },

  updateConversationInPlace: (conversationId: string, patch: Partial<ConversationSummary>) => {
    set((state) => {
      const idx = state.conversations.findIndex((c) => c.id === conversationId);
      if (idx === -1) return state;
      const updated = { ...state.conversations[idx], ...patch };
      const rest = state.conversations.filter((c) => c.id !== conversationId);
      // Move updated conversation to front (most recently active)
      return { conversations: [updated, ...rest] };
    });
  },

  resetForWorkspaceSwitch: (workspaceId: string | null) => {
    set({
      conversations: [],
      activeConversationId: null,
      openedTabIds: [],
      isLoading: false,
      _workspaceFilter: workspaceId,
    });
  },
}));

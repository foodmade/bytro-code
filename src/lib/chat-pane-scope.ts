import type { SplitPaneId } from "@/stores";
import { useConversationStore } from "@/stores/conversation-store";

export interface ChatPaneScopeOptions {
  readonly paneId?: SplitPaneId;
  readonly conversationId?: string | null;
}

export interface ResolvedChatPaneScope {
  readonly paneId: SplitPaneId | null;
  readonly conversationId: string | null;
  readonly isPaneScoped: boolean;
}

export function resolveChatPaneScope(options?: ChatPaneScopeOptions): ResolvedChatPaneScope {
  const paneId = options?.paneId ?? null;
  if (paneId !== null) {
    return {
      paneId,
      conversationId: options?.conversationId ?? null,
      isPaneScoped: true,
    };
  }

  return {
    paneId: null,
    conversationId: useConversationStore.getState().activeConversationId,
    isPaneScoped: false,
  };
}

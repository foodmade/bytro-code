import type { UnlistenFn } from "@tauri-apps/api/event";
import { useStreamStateStore } from "@/stores/stream-state-store";
import type { StreamRequestRegistry } from "@/lib/chat-stream-registry";
import {
  registerMessageHandlers,
  registerToolHandlers,
  registerSystemHandlers,
  registerFileChangeHandlers,
  type ListenerParams,
} from "@/lib/stream-handlers";

/**
 * Register all chat-stream event listeners.
 *
 * Delegates to three handler groups:
 *   - **message-handlers**  (chat-delta, chat-complete, chat-thinking-delta, chat-media)
 *   - **tool-handlers**     (chat-tool-use, chat-tool-result, chat-tool-confirm,
 *                            chat-tool-denied, chat-ask-user-question)
 *   - **system-handlers**   (chat-done, chat-error, chat-session, chat-usage,
 *                            chat-stream-usage, chat-subagent-started,
 *                            chat-subagent-stopped, chat-todo-updated,
 *                            chat-system-init, chat-compact)
 *
 * Returns a flat array of unlisten functions that the caller can invoke to
 * tear down every listener at once.
 */
export async function registerChatStreamListeners(params: {
  readonly registry: StreamRequestRegistry;
  readonly shouldIgnore: () => boolean;
  readonly setStreamingMessageId: (messageId: string | null) => void;
}): Promise<UnlistenFn[]> {
  const { registry, shouldIgnore, setStreamingMessageId } = params;

  const syncWriter = {
    setStreamingMessageId,
    setStreamingConversationId: (conversationId: string | null) => {
      useStreamStateStore.getState().setStreamingConversationId(conversationId);
    },
    setStreaming: (streaming: boolean) => {
      useStreamStateStore.getState().setStreaming(streaming);
    },
  };

  const listenerParams: ListenerParams = {
    registry,
    shouldIgnore,
    syncWriter,
  };

  // Register all handler groups in parallel -- they are independent.
  const [messageUnlistens, toolUnlistens, systemUnlistens, fileChangeUnlistens] = await Promise.all([
    registerMessageHandlers(listenerParams),
    registerToolHandlers(listenerParams),
    registerSystemHandlers(listenerParams),
    registerFileChangeHandlers(listenerParams),
  ]);

  return [...messageUnlistens, ...toolUnlistens, ...systemUnlistens, ...fileChangeUnlistens];
}
